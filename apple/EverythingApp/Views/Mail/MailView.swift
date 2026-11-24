import SwiftUI
import EACore

/// Mail (module mail_inbox): the iCloud Inbox in the app's own look, with Pin, Done and Snooze, as on the web
/// (web/src/views/Mail.tsx). Mail grouped by day, kinds of mail gathered into colored bundles, and the Inbox, Snoozed,
/// Done and each bundle as places to look, picked from the title. A thread (a back-and-forth, the owner's replies in
/// it) is one row and opens on its own screen (on the Mac, beside the list).
///
/// Mail is hostile input: its HTML only as the hub cleaned it, in a view where nothing of it runs or loads
/// (MailPageView), else as text with links only through `Mail.textParts`, which checks them; the sender's real
/// address on every open message; a brand's logo only when iCloud verified it. Nothing of a mail is kept on the
/// device (MailStore).
struct MailView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
    @StateObject private var store = MailStore()
    @State private var place: Mail.Place = .inbox
    @State private var query = ""
    @State private var pinnedOnly = false
    /// Bundles opened in place in the Inbox, as `<day>:<bundle>`.
    @State private var openBundles: Set<String> = []
    /// Selected rows: thread ids (bundle and reminder rows are never kept selected).
    @State private var selection: Set<String> = []
    /// The thread open on its own screen (iPhone and iPad).
    @State private var opened: OpenThread?
    @State private var snoozing: SnoozeTarget?
    @State private var editing: BundleEdit?
    @State private var showSettings = false
    @State private var newReminder = false
    @State private var clock = Date()
    @FocusState private var searchFocused: Bool
    #if os(iOS)
    @State private var editMode: EditMode = .inactive
    #endif

    struct OpenThread: Hashable, Identifiable { var id: String }
    struct SnoozeTarget: Identifiable {
        let id = UUID()
        var threads: [MailThread] = []
        var reminder: Mail.DueReminder?
    }
    struct BundleEdit: Identifiable {
        var id: String { start?.id ?? "new" }
        var start: MailCustomBundle?
    }

    private var shown: [Mail.Bundle] { Mail.shownBundles(on: { model.modules.isOn($0) }, custom: store.customBundles) }
    private var here: Mail.Bundle? { if case .bundle(let id) = place { return shown.first { $0.id == id } } else { return nil } }
    private var title: String {
        switch place {
        case .inbox: return "Inbox"
        case .snoozed: return "Snoozed"
        case .done: return "Done"
        case .bundle: return here?.name ?? "Inbox"
        }
    }
    /// Search: a thread shows when any of its messages has every word.
    private var threads: [MailThread] {
        let q = query.trimmingCharacters(in: .whitespaces)
        return q.isEmpty ? store.threads : store.threads.filter { $0.members.contains { Mail.matches($0, q) } }
    }
    private var byId: [String: MailThread] { Dictionary(store.threads.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a }) }
    private var chosen: [MailThread] { let all = byId; return selection.compactMap { all[$0] } }
    private var reminders: [Mail.DueReminder] {
        guard place == .inbox, !pinnedOnly, query.trimmingCharacters(in: .whitespaces).isEmpty else { return [] }
        return Mail.dueReminders(engine.list(.task), now: clock)
    }
    private var isMac: Bool {
        #if os(macOS)
        return true
        #else
        return false
        #endif
    }

    var body: some View {
        Group {
            #if os(macOS)
            HStack(spacing: 0) {
                list.frame(minWidth: 320, idealWidth: 400, maxWidth: 460)
                Divider()
                macDetail.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            #else
            list
            #endif
        }
        .navigationTitle(title)
        .toolbar { toolbar }
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        .environment(\.editMode, $editMode)
        .pageDestination(item: $opened) { t in
            MailThreadView(store: store, id: t.id, snooze: { snoozing = SnoozeTarget(threads: [$0]) }, closed: { opened = nil })
        }
        #endif
        .searchable(text: $query, prompt: "Search mail")
        .searchFocused($searchFocused)
        .sheet(item: $snoozing) { target in
            MailSnoozeSheet(store: store, target: target, engine: engine)
        }
        .sheet(item: $editing) { e in
            MailBundleForm(store: store, start: e.start) { id in
                editing = nil
                place = id.map { .bundle($0) } ?? .inbox
            }
        }
        .sheet(isPresented: $showSettings) { MailSettingsSheet(store: store) }
        .sheet(isPresented: $newReminder) { NewReminderSheet() }
        .overlay(alignment: .bottom) { undoBar }
        #if os(iOS)
        // The selection's actions, above the tab bar (a toolbar at the bottom sits under it).
        .safeAreaInset(edge: .bottom, spacing: 0) { if editMode == .active { selectionBar } }
        #endif
        .task(id: engine.client.map { ObjectIdentifier($0) }) {
            store.attach(engine.client)
            // Again every minute while the screen shows (the hub refreshes the mailboxes every 15).
            while !Task.isCancelled {
                await store.load()
                clock = Date()
                try? await Task.sleep(for: .seconds(60))
            }
        }
        .onChange(of: place) { _, _ in selection = []; opened = nil }
        // A bundle whose module was switched off, or the owner's bundle deleted: back to the Inbox.
        .onChange(of: shown.map(\.id)) { _, ids in if case .bundle(let id) = place, !ids.contains(id) { place = .inbox } }
        .onChange(of: selection) { _, s in takeRowTaps(s) }
        #if DEBUG
        .task { await debugLaunch() }
        #endif
    }

    /// The title takes the color of where you are, as the web's bar does: white words on the place's fill. It is the
    /// menu of places, too.
    private var barKey: MailColors.Key { here.map(MailColors.key) ?? MailColors.key(place) }
    private var placeSymbol: String {
        switch place {
        case .inbox: return "tray"
        case .snoozed: return "clock"
        case .done: return "checkmark"
        case .bundle: return here?.symbol ?? "tray"
        }
    }

    private var titleMenu: some View {
        Menu { placeMenu } label: {
            HStack(spacing: 6) {
                Image(systemName: placeSymbol).font(.subheadline.weight(.semibold))
                Text(verbatim: title).font(.headline)
                Image(systemName: "chevron.down").font(.caption.weight(.bold))
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 14).padding(.vertical, 6)
            .background(Capsule().fill(MailFill(key: barKey)))
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .accessibilityLabel("\(title). Show Inbox, Snoozed, Done and the bundles")
    }

    // MARK: The list

    private var list: some View {
        List(selection: $selection) {
            notes
            if store.list == nil {
                if let e = store.loadError { Text(verbatim: e).foregroundStyle(.dangerText) } else { ProgressView().frame(maxWidth: .infinity) }
            } else if store.list?.mailboxes.isEmpty == true {
                noMailbox
            } else if place == .inbox {
                inbox
            } else {
                flat
            }
            if store.list?.mailboxes.contains(where: \.more) == true {
                Text("Bringing in more of your Inbox. The rest arrives over the next few minutes.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }
        #if os(iOS)
        .listStyle(.insetGrouped)
        .refreshable { await store.refresh() }
        #else
        .listStyle(.inset)
        #endif
        .contextMenu(forSelectionType: String.self) { ids in
            rowMenu(ids)
        } primaryAction: { ids in
            if ids.count == 1, let id = ids.first { openRow(id) }
        }
        .onKeyPress(phases: .down) { press in keyPress(press) }
    }

    @ViewBuilder private var notes: some View {
        if let e = store.actionError {
            Text(verbatim: e).font(.footnote).foregroundStyle(.dangerText)
        }
        if let n = store.refreshNote {
            Text(verbatim: n.text).font(.footnote).foregroundStyle(n.ok ? AnyShapeStyle(.okText) : AnyShapeStyle(.dangerText))
        }
    }

    private var noMailbox: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Link an iCloud mailbox in Settings, Connections to see your mail here.")
            Button("Open Settings") { model.section = .settings }
        }
    }

    @ViewBuilder private var inbox: some View {
        let sections = Mail.inboxSections(threads, shown: shown, pinnedOnly: pinnedOnly, now: clock, delivery: store.delivery)
        let due = reminders
        if sections.isEmpty && due.isEmpty {
            if !query.trimmingCharacters(in: .whitespaces).isEmpty {
                Text("No mail has all of those words.").foregroundStyle(.secondary)
            } else if store.list?.mailboxes.contains(where: { $0.last_refresh != nil }) == false {
                Text("Your Inbox arrives with the first refresh, a minute or so after the hub starts. Refresh brings it now.").foregroundStyle(.secondary)
            } else {
                MailEmpty(title: pinnedOnly ? "No pinned mail" : "You're all done", text: pinnedOnly ? "Pinned mail stays here." : "Nothing left in your Inbox.")
            }
        } else {
            // Due reminders lead Today (a Today of their own when no mail came today).
            let list = due.isEmpty || sections.first?.title == "Today" ? sections : [Mail.DaySection<MailThread>(title: "Today", rows: [])] + sections
            ForEach(Array(list.enumerated()), id: \.element.title) { i, s in
                SwiftUI.Section {
                    if i == 0 {
                        ForEach(due) { r in reminderRow(r) }
                    }
                    ForEach(Array(s.rows.enumerated()), id: \.offset) { _, r in
                        switch r {
                        case .mail(let t): threadRow(t)
                        case .bundle(let b, let mails): bundleRows(b, mails, day: s.title)
                        }
                    }
                } header: {
                    sectionHeader(s.title, mails: s.rows.flatMap { r -> [MailThread] in
                        switch r { case .mail(let t): return [t]; case .bundle(_, let ms): return ms }
                    })
                }
            }
        }
    }

    @ViewBuilder private var flat: some View {
        let ms = Mail.viewMessages(threads, view: place, shown: shown)
        if let b = here {
            SwiftUI.Section {
                MailModuleLink(bundle: b)
                if b.custom != nil, let c = store.customBundles.first(where: { $0.id == b.id }) {
                    Button { editing = BundleEdit(start: c) } label: { Label("Edit bundle", systemImage: "pencil") }
                }
                MailDeliveryControl(store: store, bundle: b, mails: ms)
            }
        }
        if ms.isEmpty {
            switch place {
            case .snoozed: MailEmpty(title: "Nothing snoozed", text: "Snoozed mail waits here until its time.")
            case .done: MailEmpty(title: "Nothing done yet", text: "Mail you mark done shows here.")
            default: MailEmpty(title: "No \(here?.name.lowercased() ?? "") mail", text: "New mail of this kind gathers here.")
            }
        } else {
            SwiftUI.Section {
                ForEach(ms) { t in threadRow(t) }
            }
        }
    }

    private func sectionHeader(_ title: String, mails: [MailThread]) -> some View {
        HStack {
            Text(title)
            Spacer()
            let ids = MailStore.sweepIds(mails)
            if !ids.isEmpty {
                Button { Task { await store.move(ids, toDone: true) } } label: { Label("Sweep", systemImage: "checkmark") }
                    .font(.caption.weight(.semibold))
                    .buttonStyle(.borderless)
                    .help("Mark \(ids.count) done (pinned mail stays)")
                    .accessibilityLabel("Sweep: mark \(ids.count) done, pinned mail stays")
            }
        }
    }

    // MARK: Rows

    private func threadRow(_ t: MailThread) -> some View {
        MailThreadRow(thread: t, logos: store.list?.logos ?? [:], shown: shown)
            .tag(t.id)
            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                Button { Task { await store.done([t], inDone: t.state == .done) } } label: {
                    t.state == .done ? Label("Move to Inbox", systemImage: "tray") : Label("Done", systemImage: "checkmark")
                }
                .tint(MailFill(key: .place("done")))
                if t.state != .done {
                    Button { snoozing = SnoozeTarget(threads: [t]) } label: { Label("Snooze", systemImage: "clock") }
                        .tint(MailFill(key: .place("snoozed")))
                }
            }
            .swipeActions(edge: .leading, allowsFullSwipe: true) {
                Button { Task { await store.pin([t]) } } label: { t.pinned ? Label("Unpin", systemImage: "pin.slash") : Label("Pin", systemImage: "pin") }
                    .tint(MailFill(key: .place("inbox")))
                Button { Task { await store.read([t], t.isUnread) } } label: {
                    t.isUnread ? Label("Mark read", systemImage: "envelope.open") : Label("Mark unread", systemImage: "envelope.badge")
                }
                .tint(MailFill(key: .place("folder")))
            }
    }

    @ViewBuilder private func bundleRows(_ b: Mail.Bundle, _ mails: [MailThread], day: String) -> some View {
        let key = "\(day):\(b.id)"
        let open = openBundles.contains(key)
        MailBundleRow(bundle: b, mails: mails, open: open)
            .tag("bundle:\(key)")
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                let ids = MailStore.sweepIds(mails)
                if !ids.isEmpty {
                    Button { Task { await store.move(ids, toDone: true) } } label: { Label("Sweep", systemImage: "checkmark") }
                        .tint(MailFill(key: .place("done")))
                }
            }
        if open {
            MailModuleLink(bundle: b).padding(.leading, 20)
            ForEach(mails) { t in threadRow(t).padding(.leading, 20) }
        }
    }

    private func reminderRow(_ r: Mail.DueReminder) -> some View {
        MailReminderRow(reminder: r, now: clock)
            .tag("rem:\(r.id)")
            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                Button { Task { await engine.ack(r.id) } } label: { Label("Done", systemImage: "checkmark") }
                    .tint(MailFill(key: .place("done")))
                Button { snoozing = SnoozeTarget(reminder: r) } label: { Label("Snooze", systemImage: "clock") }
                    .tint(MailFill(key: .place("snoozed")))
            }
    }

    // MARK: Opening and acting

    /// A tap (or Return) on a row: a thread opens, a bundle opens or closes in place, a reminder opens its task.
    private func openRow(_ id: String) {
        if id.hasPrefix("bundle:") {
            let key = String(id.dropFirst("bundle:".count))
            withAnimation(.snappy(duration: 0.2)) { if openBundles.contains(key) { openBundles.remove(key) } else { openBundles.insert(key) } }
        } else if id.hasPrefix("rem:") {
            model.open(itemId: String(id.dropFirst("rem:".count)))
        } else if !isMac {
            opened = OpenThread(id: id)
        }
    }

    /// On the Mac a click selects: a bundle or reminder row acts at once and is not kept selected.
    private func takeRowTaps(_ s: Set<String>) {
        guard isMac, s.count == 1, let id = s.first, id.hasPrefix("bundle:") || id.hasPrefix("rem:") else {
            let kept = s.filter { !$0.hasPrefix("bundle:") && !$0.hasPrefix("rem:") }
            if kept != s { selection = kept }
            return
        }
        selection = []
        openRow(id)
    }

    @ViewBuilder private func rowMenu(_ ids: Set<String>) -> some View {
        let all = byId
        let ts = ids.compactMap { all[$0] }
        if ids.count == 1, let id = ids.first, id.hasPrefix("rem:") {
            let rid = String(id.dropFirst(4))
            Button("Open in Tasks", systemImage: "checklist") { model.open(itemId: rid) }
            Button("Done", systemImage: "checkmark") { Task { await engine.ack(rid) } }
            if let r = reminders.first(where: { $0.id == rid }) {
                Button("Snooze", systemImage: "clock") { snoozing = SnoozeTarget(reminder: r) }
            }
        } else if ids.count == 1, let id = ids.first, id.hasPrefix("bundle:") {
            let bid = String(id.split(separator: ":").last ?? "")
            Button("Show all of this bundle", systemImage: "tray.full") { place = .bundle(bid) }
        } else if !ts.isEmpty {
            actionButtons(ts)
            #if os(iOS)
            if editMode == .inactive {
                Button("Select", systemImage: "checkmark.circle") { editMode = .active; selection = Set(ts.map(\.id)) }
            }
            #endif
        }
    }

    /// Done (or Move to Inbox), Snooze, Pin, Mark read and Mark unread for threads: a row's menu.
    @ViewBuilder private func actionButtons(_ ts: [MailThread]) -> some View {
        let inDone = ts.allSatisfy { $0.state == .done }
        Button(inDone ? "Move to Inbox" : "Done", systemImage: inDone ? "tray" : "checkmark") {
            Task { await store.done(ts, inDone: inDone); selection = [] }
        }
        if !inDone {
            Button("Snooze", systemImage: "clock") { snoozing = SnoozeTarget(threads: ts.filter { $0.state != .done }) }
        }
        if ts.count == 1, let t = ts.first, t.state == .snoozed {
            Button("Unsnooze", systemImage: "tray") { Task { await store.unsnooze(t) } }
        }
        Button(ts.allSatisfy(\.pinned) ? "Unpin" : "Pin", systemImage: "pin") { Task { await store.pin(ts) } }
        Button("Mark read", systemImage: "envelope.open") { Task { await store.read(ts, true) } }
        Button("Mark unread", systemImage: "envelope.badge") { Task { await store.read(ts, false) } }
    }

    // MARK: Keys (iPad and Mac keyboards)

    private func keyPress(_ press: KeyPress) -> KeyPress.Result {
        let name: String
        switch press.key {
        case .escape: name = "escape"
        case .return: name = "return"
        default: name = press.characters
        }
        guard let a = Mail.keyAction(name, control: press.modifiers.contains(.control), command: press.modifiers.contains(.command), option: press.modifiers.contains(.option)) else { return .ignored }
        let ts = chosen
        switch a {
        case .escape:
            guard !selection.isEmpty else { return .ignored }
            selection = []
        case .search: searchFocused = true
        case .help: showSettings = true
        case .open, .select: return .ignored
        case .done: guard !ts.isEmpty else { return .ignored }; Task { await store.done(ts, inDone: place == .done); selection = [] }
        case .snooze: guard !ts.isEmpty, place != .done else { return .ignored }; snoozing = SnoozeTarget(threads: ts)
        case .pin: guard !ts.isEmpty else { return .ignored }; Task { await store.pin(ts) }
        case .read, .unread: guard !ts.isEmpty else { return .ignored }; Task { await store.read(ts, a == .read) }
        }
        return .handled
    }

    // MARK: Toolbar and places

    @ViewBuilder private var placeMenu: some View {
        // Counted as the list shows them: mail of a bundle this app has no view for is not held back.
        let held = Mail.shownDelivery(store.delivery, shown: shown)
        let unread = store.threads.filter { $0.state == .inbox && $0.isUnread && Mail.inboxAt($0.summary, delivery: held, now: clock) != nil }.count
        let snoozed = store.threads.filter { $0.state == .snoozed }.count
        Button { place = .inbox } label: { Label(unread > 0 ? "Inbox (\(unread) new)" : "Inbox", systemImage: "tray") }
        Button { place = .snoozed } label: { Label(snoozed > 0 ? "Snoozed (\(snoozed))" : "Snoozed", systemImage: "clock") }
        Button { place = .done } label: { Label("Done", systemImage: "checkmark") }
        SwiftUI.Section("Bundles") { bundleButtons(shown.filter { $0.module == nil && $0.custom == nil }) }
        if shown.contains(where: { $0.module != nil }) {
            SwiftUI.Section("From your modules") { bundleButtons(shown.filter { $0.module != nil }) }
        }
        SwiftUI.Section("Your bundles") {
            bundleButtons(shown.filter { $0.custom != nil })
            Button { editing = BundleEdit(start: nil) } label: { Label("New bundle", systemImage: "plus") }
        }
    }

    private func bundleButtons(_ bs: [Mail.Bundle]) -> some View {
        ForEach(bs) { b in
            let n = store.threads.filter { $0.state == .inbox && $0.summary.bundle == b.id && $0.isUnread }.count
            Button { place = .bundle(b.id) } label: { Label(n > 0 ? "\(b.name) (\(n) new)" : b.name, systemImage: b.symbol) }
        }
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .principal) { titleMenu }
        #if os(iOS)
        if editMode == .active {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Done") { editMode = .inactive; selection = [] }
            }
        } else {
            commonItems
        }
        #else
        commonItems
        if !chosen.isEmpty {
            ToolbarItemGroup(placement: .automatic) {
                Text("\(chosen.count) selected")
                Button { Task { await store.done(chosen, inDone: place == .done); selection = [] } } label: {
                    Label(place == .done ? "Move to Inbox" : "Done", systemImage: place == .done ? "tray" : "checkmark")
                }
                if place != .done { Button { snoozing = SnoozeTarget(threads: chosen) } label: { Label("Snooze", systemImage: "clock") } }
                Button { Task { await store.pin(chosen) } } label: { Label(chosen.allSatisfy(\.pinned) ? "Unpin" : "Pin", systemImage: "pin") }
                Button { Task { await store.read(chosen, true) } } label: { Label("Mark read", systemImage: "envelope.open") }
                Button { Task { await store.read(chosen, false) } } label: { Label("Mark unread", systemImage: "envelope.badge") }
            }
        }
        #endif
    }

    /// Pinned only (in the Inbox), Refresh and the rest. On the iPhone the bar has room for the title, Pinned only and
    /// one menu, so Refresh (also a pull on the list) and Select are in the menu.
    @ToolbarContentBuilder private var commonItems: some ToolbarContent {
        ToolbarItemGroup(placement: .primaryAction) {
            if place == .inbox {
                Toggle(isOn: $pinnedOnly) { Label("Pinned only", systemImage: pinnedOnly ? "pin.fill" : "pin") }
                    .help("Pinned only")
            }
            #if os(macOS)
            Button { Task { await store.refresh() } } label: {
                if store.refreshing { ProgressView() } else { Label("Refresh", systemImage: "arrow.clockwise") }
            }
            .disabled(store.refreshing || engine.client == nil)
            .help("Refresh")
            #endif
            Menu {
                #if os(iOS)
                Button { editMode = .active } label: { Label("Select", systemImage: "checkmark.circle") }
                Button { Task { await store.refresh() } } label: { Label(store.refreshing ? "Refreshing" : "Refresh", systemImage: "arrow.clockwise") }
                    .disabled(store.refreshing || engine.client == nil)
                #endif
                Button { newReminder = true } label: { Label("Reminder", systemImage: "bell") }
                Button { editing = BundleEdit(start: nil) } label: { Label("New bundle", systemImage: "plus") }
                Button { showSettings = true } label: {
                    Label(store.list?.mailboxes.contains { $0.last_error != nil } == true ? "Mailboxes and settings (a mailbox has a problem)" : "Mailboxes and settings",
                          systemImage: store.list?.mailboxes.contains { $0.last_error != nil } == true ? "exclamationmark.circle" : "info.circle")
                }
            } label: { Label("More", systemImage: "ellipsis.circle") }
        }
    }

    #if os(iOS)
    private var selectionBar: some View {
        let ts = chosen
        return HStack(spacing: 18) {
            Text(ts.isEmpty ? "Select mail" : "\(ts.count) selected").font(.subheadline.weight(.semibold))
            Spacer(minLength: 4)
            Group {
                Button { Task { await store.done(ts, inDone: place == .done); selection = [] } } label: {
                    Label(place == .done ? "Move to Inbox" : "Done", systemImage: place == .done ? "tray" : "checkmark")
                }
                if place != .done {
                    Button { snoozing = SnoozeTarget(threads: ts) } label: { Label("Snooze", systemImage: "clock") }
                }
                Button { Task { await store.pin(ts) } } label: { Label(ts.allSatisfy(\.pinned) && !ts.isEmpty ? "Unpin" : "Pin", systemImage: "pin") }
                Button { Task { await store.read(ts, true) } } label: { Label("Mark read", systemImage: "envelope.open") }
                Button { Task { await store.read(ts, false) } } label: { Label("Mark unread", systemImage: "envelope.badge") }
            }
            .labelStyle(.iconOnly)
            .font(.title3)
            .disabled(ts.isEmpty)
        }
        .padding(.horizontal, 20).padding(.vertical, 12)
        .background(.bar, in: Capsule())
        .padding(.horizontal, 12).padding(.bottom, 6)
    }
    #endif

    @ViewBuilder private var undoBar: some View {
        if let u = store.undo {
            HStack(spacing: 14) {
                Text(verbatim: u.text).foregroundStyle(.white)
                Button("Undo") { let run = u.run; store.undo = nil; Task { await run() } }
                    .fontWeight(.semibold)
                    .foregroundStyle(.white)
                    .buttonStyle(.plain)
            }
            .padding(.horizontal, 18).padding(.vertical, 12)
            .background(Capsule().fill(MailFill(key: .place("folder"))))
            .padding(.bottom, 16)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .accessibilityElement(children: .contain)
        }
    }

    // MARK: Mac: the open thread beside the list

    #if os(macOS)
    @ViewBuilder private var macDetail: some View {
        if selection.count == 1, let id = selection.first, store.thread(id) != nil {
            MailThreadView(store: store, id: id, snooze: { snoozing = SnoozeTarget(threads: [$0]) }, closed: { selection = [] })
                .id(id)
        } else if selection.count > 1 {
            Text("\(chosen.count) selected").font(.title3).foregroundStyle(.secondary)
        } else {
            Text("Pick a mail to read it.").font(.title3).foregroundStyle(.secondary)
        }
    }
    #endif

    // MARK: Simulator and Mac screenshots (Debug builds)

    #if DEBUG
    /// `-EAMailPlace bundle:<id>|snoozed|done` opens that place; `-EAMailOpen <words>` opens the first thread whose
    /// subject has them; `-EAMailSelect <n>` selects the first n threads; `-EAMailBundleOpen YES` opens the first bundle row.
    private func debugLaunch() async {
        let d = UserDefaults.standard
        if let p = d.string(forKey: "EAMailPlace") {
            place = p == "snoozed" ? .snoozed : p == "done" ? .done : p.hasPrefix("bundle:") ? .bundle(String(p.dropFirst(7))) : .inbox
        }
        for _ in 0..<40 where store.list == nil { try? await Task.sleep(for: .milliseconds(250)) }
        if let words = d.string(forKey: "EAMailOpen"), let t = store.threads.first(where: { $0.summary.subject.localizedCaseInsensitiveContains(words) }) {
            if isMac { selection = [t.id] } else { opened = OpenThread(id: t.id) }
        }
        let n = d.integer(forKey: "EAMailSelect")
        if n > 0 {
            #if os(iOS)
            editMode = .active
            #endif
            selection = Set(Mail.viewMessages(store.threads, view: .inbox, shown: shown).filter { $0.summary.bundle == nil || $0.pinned }.prefix(n).map(\.id))
        }
        if d.bool(forKey: "EAMailBundleOpen") {
            let s = Mail.inboxSections(store.threads, shown: shown, now: clock, delivery: store.delivery)
            for sec in s { for r in sec.rows { if case .bundle(let b, _) = r { openBundles.insert("\(sec.title):\(b.id)"); return } } }
        }
    }
    #endif
}

/// An empty place: what it is for, in a sentence.
struct MailEmpty: View {
    var title: String
    var text: String
    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: "sun.max").font(.title).foregroundStyle(.secondary)
            Text(title).font(.headline)
            Text(text).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 24)
    }
}

/// A module's bundle says where its mail was sorted from, with a way to that screen.
struct MailModuleLink: View {
    @EnvironmentObject var model: AppModel
    var bundle: Mail.Bundle

    private var section: Section? {
        switch bundle.module {
        case "renewals": return .renewals
        case "pet": return .pet
        case "jobs": return .career
        default: return nil
        }
    }

    var body: some View {
        if let name = bundle.moduleName, let s = section {
            HStack {
                Text("Sorted using your \(name) records.").font(.footnote).foregroundStyle(.secondary)
                Spacer(minLength: 8)
                Button("Open \(name) \u{203A}") { model.section = s }
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(MailWord(key: bundle.colorKey))
                    .buttonStyle(.borderless)
            }
        }
    }
}
