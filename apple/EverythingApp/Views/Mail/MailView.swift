import SwiftUI
import EACore

/// Mail (module mail_inbox): each linked mailbox's Inbox in the app's own look, with Pin, Done and Snooze, as on the web
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
    /// Add an account, from the screen with no mailbox linked.
    @State private var addingAccount = false
    @State private var query = ""
    @State private var pinnedOnly = false
    /// Bundles opened in place in the Inbox, as `<day>:<bundle>`.
    @State private var openBundles: Set<String> = []
    /// Selected rows: thread ids, or one folder's mail (`folder:<id>`). Bundle and reminder rows are never kept selected.
    @State private var selection: Set<String> = []
    /// The thread, or a folder's mail, open on its own screen (iPhone and iPad).
    @State private var opened: OpenThread?
    /// A folder lists its mail 100 at a time.
    @State private var folderShown = 100
    /// A thread to open once the place it is listed in shows (Needs you, a search hit), and to bring into view.
    @State private var pendingOpen: String?
    @State private var reveal: String?
    /// The people view: all mail with one person, in the list's place until closed or another place is chosen.
    @State private var person: MailAddress?
    @State private var showKeys = false
    @State private var snoozing: SnoozeTarget?
    @State private var editing: BundleEdit?
    @State private var showSettings = false
    /// New mail's writing box: a sheet on the iPhone and iPad; on the Mac in the reading pane, open again when it was
    /// open the last time the screen showed, and kept until Close once saved (saving lets the screen's keeping go).
    @State private var composingNew = MailWriting.shared.open[Mail.newMailKey] != nil
    @State private var newMailPressed = false
    /// A mail that was not sent, asked about before it is discarded.
    @State private var discarding: MailOutboxItem?
    @State private var clock = Date()
    @FocusState private var searchFocused: Bool
    #if os(iOS)
    @State private var editMode: EditMode = .inactive
    /// A wide iPad, where a keyboard is likely: the keys list is offered.
    @Environment(\.horizontalSizeClass) private var sizeClass
    #endif

    /// What is open on its own screen: a thread by its id, a folder's mail (`folder`: the folder's key), or a search hit.
    struct OpenThread: Hashable, Identifiable { var id: String; var folder: String? = nil; var hit = false }
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
        case .folder: return folder.map { Mail.folderLabel($0) } ?? "Inbox"
        }
    }
    /// The folder shown, while it is one the hub lists.
    private var folder: MailFolder? { if case .folder(let key) = place { return store.list?.folders.first { $0.key == key } } else { return nil } }
    /// Search: a thread shows when any of its messages has every word.
    private var threads: [MailThread] {
        let q = query.trimmingCharacters(in: .whitespaces)
        return q.isEmpty ? store.threads : store.threads.filter { $0.members.contains { Mail.matches($0, q) } }
    }
    /// The threads by their key (MailThread.key), what a row is tagged, selected and opened by.
    private var byId: [String: MailThread] { Dictionary(store.threads.map { ($0.key, $0) }, uniquingKeysWith: { a, _ in a }) }
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
        #if DEBUG
        let _ = MailProbe.count("MailView")
        #endif
        Group {
            #if os(macOS)
            HStack(spacing: 0) {
                macRail.frame(width: 210)
                Divider()
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
            if t.hit {
                MailHitView(store: store, id: t.id, inPersonView: person != nil, showInPlace: showInPlace, showPerson: showPerson)
            } else if let key = t.folder {
                if let f = store.list?.folders.first(where: { $0.key == key }) {
                    MailFolderMailView(store: store, id: t.id, folder: f) { opened = nil }
                } else {
                    MailEmpty(title: "Not here any more", text: "This mail left the folder you opened it from.")
                }
            } else {
                MailThreadView(store: store, id: t.id, snooze: { snoozing = SnoozeTarget(threads: [$0]) }, closed: { opened = nil }, showPerson: showPerson)
            }
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
        .sheet(isPresented: $showKeys) { MailKeysSheet() }
        .sheet(isPresented: $addingAccount) { AddAccountSheet { _ in await store.refresh() } }
        #if os(iOS)
        .sheet(isPresented: $composingNew) {
            NavigationStack {
                ScrollView { MailComposer(store: store, target: .fresh) { composingNew = false }.padding() }
                    .navigationTitle("New mail")
                    .navigationBarTitleDisplayMode(.inline)
            }
        }
        #endif
        .overlay(alignment: .bottom) { undoBar }
        .confirmationDialog(Mail.SendTexts.discard, isPresented: Binding(get: { discarding != nil }, set: { if !$0 { discarding = nil } }), titleVisibility: .visible) {
            Button("Discard", role: .destructive) { if let x = discarding { Task { await store.act { try await $0.mailOutboxUndo(x.id) } } }; discarding = nil }
        }
        // Asked here while the list shows (a page open over it on the iPhone and iPad asks on that page).
        .mailMoveQuestion(store, when: opened == nil)
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
        // Searching every kept mail on the hub (from 3 letters typed), or all mail with one person: asked a moment
        // after the search stops changing, and again with each list.
        .task(id: searchKey) {
            guard let k = searchKey else { store.clearHits(); return }
            try? await Task.sleep(for: .milliseconds(300))
            if !Task.isCancelled { await store.search(k.q, with: k.person) }
        }
        .onChange(of: place) { _, _ in
            selection = []; opened = nil; folderShown = 100; person = nil
            if let id = pendingOpen { pendingOpen = nil; open(id) }
        }
        // While the hub's model sorts new mail and the Inbox shows, the list is asked for again every 4 seconds, so
        // Needs you fills in and the count goes down; it stops with the run, and when the screen closes.
        .task(id: sorting) {
            while sorting && !Task.isCancelled {
                try? await Task.sleep(for: .seconds(4))
                if !Task.isCancelled { await store.load() }
            }
        }
        // A folder's mail: fetched when the folder shows, and again with each list.
        .task(id: "\(folder?.key ?? ""):\(store.listStamp)") { if let f = folder { await store.loadFolder(f.key) } }
        // A folder that is gone (its mailbox unlinked): back to the Inbox.
        .onChange(of: store.list?.folders.map(\.key)) { _, keys in if case .folder(let k) = place, let keys, !keys.contains(k) { place = .inbox } }
        // A bundle whose module was switched off, or the owner's bundle deleted: back to the Inbox.
        .onChange(of: shown.map(\.id)) { _, ids in if case .bundle(let id) = place, !ids.contains(id) { place = .inbox } }
        .onChange(of: selection) { _, s in takeRowTaps(s) }
        // A mail the assistant wrote, opened with Edit on its card: New mail's box, filled with it.
        .onReceive(NotificationCenter.default.publisher(for: .mailOpenNewMail)) { _ in
            #if os(macOS)
            selection = []
            #endif
            composingNew = true
        }
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
        case .folder: return folder.map { $0.role.symbol } ?? "folder"
        }
    }

    @ViewBuilder private var titleMenu: some View {
        #if os(macOS)
        // The side list beside the mail holds the places, as the web's does.
        titleLabel(chevron: false).accessibilityElement(children: .combine)
        #else
        Menu { placeMenu } label: { titleLabel(chevron: true) }
            .menuStyle(.button)
            .buttonStyle(.plain)
            .accessibilityLabel("\(title). Show Inbox, Snoozed, Done and the bundles")
        #endif
    }

    private func titleLabel(chevron: Bool) -> some View {
        HStack(spacing: 6) {
            Image(systemName: placeSymbol).font(.subheadline.weight(.semibold))
            Text(verbatim: title).font(.headline)
            if chevron { Image(systemName: "chevron.down").font(.caption.weight(.bold)) }
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 14).padding(.vertical, 6)
        .background(Capsule().fill(MailFill(key: barKey)))
    }

    // MARK: The list

    private var list: some View {
        ScrollViewReader { proxy in
        List(selection: $selection) {
            notes
            if store.list == nil {
                if let e = store.loadError { Text(verbatim: e).foregroundStyle(.dangerText) } else { ProgressView().frame(maxWidth: .infinity) }
            } else if store.list?.mailboxes.isEmpty == true {
                noMailbox
            } else if let p = person {
                hitsSection("With \(Mail.personLabel(p))", sub: p.address) { person = nil }
            } else if let f = folder {
                folderList(f)
            } else if place == .inbox {
                inbox
            } else {
                flat
            }
            // Typing a search: beside the place's own matches, every kept mail's (whole texts, folders too).
            if person == nil, searchKey != nil {
                hitsSection("In all your mail")
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
        .onChange(of: reveal) { _, r in
            guard let r else { return }
            reveal = nil
            Task { try? await Task.sleep(for: .milliseconds(150)); withAnimation { proxy.scrollTo(r, anchor: .top) } }
        }
        }
    }

    /// What the hub is searched for now: all mail with the person shown, else the typed words from 3 letters on; nil
    /// for no search (or no mailbox yet).
    private struct SearchKey: Hashable { var q: String; var person: String; var stamp: Int }
    private var searchKey: SearchKey? {
        guard store.list?.mailboxes.isEmpty == false else { return nil }
        if let p = person { return SearchKey(q: "", person: p.address, stamp: store.listStamp) }
        let q = query.trimmingCharacters(in: .whitespaces)
        return q.count >= Mail.searchEverywhereFrom ? SearchKey(q: q, person: "", stamp: store.listStamp) : nil
    }

    /// All mail with one person, in the list's place.
    private func showPerson(_ who: MailAddress) {
        person = who
        selection = []
        opened = nil
    }

    /// A search hit shown where it is listed (the Inbox, Snoozed or Done).
    private func showInPlace(_ h: MailSearchHit) {
        if let t = store.threads.first(where: { $0.members.contains { $0.id == h.id } }) { person = nil; showThread(t) }
    }

    /// The search hits under the list: every kept mail with the words, or all mail with one person (`title`).
    @ViewBuilder private func hitsSection(_ title: String, sub: String? = nil, close: (() -> Void)? = nil) -> some View {
        SwiftUI.Section {
            if let e = store.hitsError {
                Text(verbatim: e).foregroundStyle(.dangerText)
            } else if let hits = store.hits {
                if hits.isEmpty { Text("Nothing found.").foregroundStyle(.secondary) }
                ForEach(hits) { h in MailHitRow(hit: h).tag("hit:\(h.id)") }
            } else {
                Text("Searching").foregroundStyle(.secondary)
            }
        } header: {
            HStack {
                Text(verbatim: title + (store.hits.map { " (\($0.count)\($0.count >= Mail.searchMax ? "+" : ""))" } ?? ""))
                if let sub { Text(verbatim: sub).foregroundStyle(.secondary).lineLimit(1) }
                Spacer()
                if let close { Button("Close", action: close).buttonStyle(.borderless) }
            }
        }
    }

    /// The threads on the screen now, for Select all: the rows in sight (a closed bundle's mail is not).
    private var shownThreadIds: [String] {
        switch place {
        case .folder: return []
        case .inbox:
            var out: [String] = []
            let only = pinnedOnly || !query.trimmingCharacters(in: .whitespaces).isEmpty
            if !only { out += Mail.backLaterToday(threads, now: clock).map(\.key) }
            for sec in Mail.inboxSections(threads, shown: shown, pinnedOnly: pinnedOnly, now: clock, delivery: store.delivery) {
                for r in sec.rows {
                    switch r {
                    case .mail(let t): out.append(t.key)
                    case .bundle(let b, let ms): if openBundles.contains("\(sec.title):\(b.id)") { out += ms.map(\.key) }
                    }
                }
            }
            return out
        default:
            let all = Mail.viewMessages(threads, view: place, shown: shown)
            return (here != nil && pinnedOnly ? all.filter(\.pinned) : all).map(\.key)
        }
    }

    /// Select all shown, or none when all are.
    @ViewBuilder private var selectAllButton: some View {
        let ids = shownThreadIds
        let sel = Mail.selectAll(ids, selection)
        Button { selection = sel.next } label: {
            Label(sel.state == .all ? "Select none" : "Select all shown (\(ids.count))", systemImage: sel.state == .all ? "checkmark.circle.fill" : "checklist")
        }
        .help(sel.state == .all ? "Select none" : "Select all shown (\(ids.count))")
    }

    /// Mail the hub's model is sorting now, while the Inbox shows.
    private var sorting: Bool { store.list?.triage != false && store.list?.triage_state?.running == true && place == .inbox }

    /// Open a thread: beside the list on the Mac, on its own page on the iPhone and iPad.
    private func open(_ id: String) {
        if isMac { selection = [id] } else { opened = OpenThread(id: id) }
        reveal = id
    }

    /// Open a thread where it is listed, and bring it into view: in Snoozed or Done; in the Inbox, with the bundle's row
    /// it is inside opened first; or, when its bundle holds it back from the Inbox, in that bundle's own view.
    private func showThread(_ t: MailThread) {
        query = ""
        pinnedOnly = false
        let to: Mail.Place
        if t.state != .inbox {
            to = t.state == .snoozed ? .snoozed : .done
        } else {
            let p = Mail.inboxPlace(Mail.inboxSections(store.threads, shown: shown, now: clock, delivery: store.delivery), key: t.key)
            if let row = p.row { openBundles.insert(row) }
            to = p.found || t.summary.bundle == nil ? .inbox : .bundle(t.summary.bundle!)
        }
        if to == place { open(t.key) } else { pendingOpen = t.key; place = to }
    }

    @ViewBuilder private var notes: some View {
        if let e = store.actionError {
            Text(verbatim: e).font(.footnote).foregroundStyle(.dangerText)
        }
        // Mail that was not sent (since 2026-11-24): never lost, whether or not the box it was written in is open. One
        // an open box shows already is left to that box.
        ForEach(store.notSent.filter { !shownInBox($0.id) }) { x in
            VStack(alignment: .leading, spacing: 6) {
                Text(verbatim: Mail.outboxLine(x)).font(.subheadline.weight(.semibold))
                if let e = x.error { Text(verbatim: e).font(.footnote).foregroundStyle(.dangerText) }
                HStack(spacing: 10) {
                    Button("Try again") { Task { await store.act { _ = try await $0.mailOutboxRetry(x.id) } } }.buttonStyle(.borderedProminent)
                    Button("Save draft") { Task { await store.act { try await $0.mailOutboxDraft(x.id) } } }.buttonStyle(.bordered)
                    Button("Discard", role: .destructive) { discarding = x }.buttonStyle(.borderless)
                }
                .controlSize(.small)
            }
            .padding(.vertical, 2)
        }
        if let n = store.refreshNote {
            Text(verbatim: n.text).font(.footnote).foregroundStyle(n.ok ? AnyShapeStyle(.okText) : AnyShapeStyle(.dangerText))
        }
    }

    /// Whether an open writing box shows this mail of the outbox already.
    private func shownInBox(_ id: String) -> Bool {
        guard let k = MailWriting.shared.key(holding: id) else { return false }
        if k == Mail.newMailKey { return composingNew }
        return MailWriting.shared.open[String(k.split(separator: ":", maxSplits: 1).last ?? "")] != nil
    }

    /// No mailbox linked: Add an account opens Settings, Accounts' Add account here, so the Mail screen leads straight
    /// to it (it pointed at Settings, which took Modules, Connections and Add Account to get there).
    private var noMailbox: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(Mail.noMailboxText)
            Button("Add an account") { addingAccount = true }
                .buttonStyle(.themedProminent)
        }
    }

    @ViewBuilder private var inbox: some View {
        let sections = Mail.inboxSections(threads, shown: shown, pinnedOnly: pinnedOnly, now: clock, delivery: store.delivery)
        let due = reminders
        let searching = !query.trimmingCharacters(in: .whitespaces).isEmpty
        let only = pinnedOnly || searching
        // The model's digest, and snoozed mail back later today: not while searching or showing pinned mail only.
        let needs = only ? [] : Mail.needsYou(threads, shown: shown, delivery: store.delivery, now: clock)
        let back = only ? [] : Mail.backLaterToday(threads, now: clock)
        // In the Needs you place, and there when Needs you is empty too.
        if !only, let row = Mail.triageRow(on: store.list?.triage, store.list?.triage_state) {
            SwiftUI.Section { MailSortRow(store: store, row: row) }
        }
        if !needs.isEmpty {
            SwiftUI.Section {
                ForEach(needs, id: \.key) { t in
                    Button { showThread(t) } label: { MailNeedRow(thread: t) }.buttonStyle(.plain)
                }
            } header: {
                Text("Needs you")
            } footer: {
                Text("Sorted by your hub's model from each mail's own words. It can be wrong.")
            }
        }
        if !back.isEmpty {
            SwiftUI.Section("Back later today") {
                ForEach(back, id: \.key) { t in threadRow(t) }
            }
        }
        if sections.isEmpty && due.isEmpty && back.isEmpty {
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
        let all = Mail.viewMessages(threads, view: place, shown: shown)
        let ms = here != nil && pinnedOnly ? all.filter(\.pinned) : all
        if let b = here {
            SwiftUI.Section {
                MailModuleLink(bundle: b)
                if b.custom != nil, let c = store.customBundles.first(where: { $0.id == b.id }) {
                    Button { editing = BundleEdit(start: c) } label: { Label("Edit bundle", systemImage: "pencil") }
                }
                MailDeliveryControl(store: store, bundle: b, mails: all)
            }
        }
        if ms.isEmpty {
            switch place {
            case .snoozed: MailEmpty(title: "Nothing snoozed", text: "Snoozed mail waits here until its time.")
            case .done: MailEmpty(title: "Nothing done yet", text: "Mail you mark done shows here.")
            default:
                if pinnedOnly {
                    MailEmpty(title: "No pinned \(here?.name.lowercased() ?? "") mail", text: "Pin a mail here and it shows while Pinned only is on.")
                } else {
                    MailEmpty(title: "No \(here?.name.lowercased() ?? "") mail", text: "New mail of this kind gathers here.")
                }
            }
        } else {
            // The Trips bundle: each trip's mail as one box first, then the mail in no trip as rows.
            let fs = Mail.flatScreen(ms, bundle: here?.id, now: clock)
            ForEach(fs.trips, id: \.id) { trip in
                SwiftUI.Section { MailTripBox(trip: trip) { open($0.key) } }
            }
            if !fs.rest.isEmpty {
                SwiftUI.Section {
                    ForEach(fs.rest, id: \.key) { t in threadRow(t) }
                }
            }
        }
    }

    /// One of the other folders: its kept mail, newest first, 100 at a time, each opening as in the Inbox, with what
    /// its folder lets it do. Spam and Drafts say what they are for.
    @ViewBuilder private func folderList(_ f: MailFolder) -> some View {
        let q = query.trimmingCharacters(in: .whitespaces)
        let all = store.folderMail[f.key]
        if f.role == .junk {
            Text("Your mail provider put this mail in Spam. Its pictures are never loaded, and its links may not be safe.").font(.footnote).foregroundStyle(.secondary)
        }
        if f.role == .drafts {
            let b = Mail.mailboxOf(store.boxes, f.email)
            Text(verbatim: Mail.canSend(b) ? "Edit opens a draft here, to send it or save it again." : "A draft is sent from \(Mail.mailApp(b)). Edit changes it here.").font(.footnote).foregroundStyle(.secondary)
        }
        if let all {
            let ms = q.isEmpty ? all : all.filter { Mail.matches($0.summary, q) }
            if ms.isEmpty {
                MailEmpty(title: q.isEmpty ? "Nothing in \(Mail.folderLabel(f))" : "No mail matches", text: f.role == .junk ? "Mail your provider takes for spam gathers here." : "Mail in this folder shows here.")
            } else {
                SwiftUI.Section {
                    ForEach(ms.prefix(folderShown)) { m in folderRow(m, f) }
                    if ms.count > folderShown {
                        Button("Show more (\(ms.count - folderShown))") { folderShown += 100 }.buttonStyle(.borderless)
                    }
                }
            }
        } else if let e = store.folderErrors[f.key] {
            Text(verbatim: e).foregroundStyle(.dangerText)
        } else {
            ProgressView().frame(maxWidth: .infinity)
        }
    }

    private func folderRow(_ m: MailFolderMail, _ f: MailFolder) -> some View {
        // A Read only mailbox's folders take no move.
        let can = store.readOnly(mailbox: f.email) ? .none : Mail.folderActs(f.role)
        let here = Mail.moveTarget(f)
        return MailFolderRow(mail: m)
            .tag("folder:\(m.id)")
            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                if can.trash {
                    Button(role: .destructive) { Task { await store.relocate([m.id], to: "trash", said: "Moved to Trash", back: can.undo ? here : nil) } } label: { Label("Delete", systemImage: "trash") }
                }
            }
            .swipeActions(edge: .leading, allowsFullSwipe: true) {
                if can.inbox {
                    Button { Task { await store.relocate([m.id], to: "inbox", said: "Moved to Inbox", back: here) } } label: {
                        Label(f.role == .junk ? "Not spam" : "Move to Inbox", systemImage: "tray")
                    }
                    .tint(MailFill(key: .place("inbox")))
                }
            }
    }

    private func sectionHeader(_ title: String, mails: [MailThread]) -> some View {
        HStack {
            Text(title)
            Spacer()
            let ids = store.sweepIds(mails)
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
        // A Read only mailbox's mail has no Done, Delete or Pin to swipe to (Snooze and the read mark are the hub's own).
        let ro = store.readOnly(t)
        return MailThreadRow(thread: t, logos: store.list?.logos ?? [:], shown: shown)
            .tag(t.key)
            .id(t.key)
            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                if !ro {
                    Button { Task { await store.done([t], inDone: t.state == .done) } } label: {
                        t.state == .done ? Label("Move to Inbox", systemImage: "tray") : Label("Done", systemImage: "checkmark")
                    }
                    .tint(MailFill(key: .place("done")))
                }
                if t.state != .done {
                    Button { snoozing = SnoozeTarget(threads: [t]) } label: { Label("Snooze", systemImage: "clock") }
                        .tint(MailFill(key: .place("snoozed")))
                }
                if !ro {
                    Button(role: .destructive) { Task { await store.relocate(t.openIds + t.doneIds, to: "trash", said: "Moved to Trash", back: "inbox") } } label: { Label("Delete", systemImage: "trash") }
                }
            }
            .swipeActions(edge: .leading, allowsFullSwipe: true) {
                if !ro {
                    Button { Task { await store.pin([t]) } } label: { t.pinned ? Label("Unpin", systemImage: "pin.slash") : Label("Pin", systemImage: "pin") }
                        .tint(MailFill(key: .place("inbox")))
                }
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
                let ids = store.sweepIds(mails)
                if !ids.isEmpty {
                    Button { Task { await store.move(ids, toDone: true) } } label: { Label("Sweep", systemImage: "checkmark") }
                        .tint(MailFill(key: .place("done")))
                }
            }
        if open {
            MailModuleLink(bundle: b).padding(.leading, 20)
            let ids = store.sweepIds(mails)
            if !ids.isEmpty {
                Button { Task { await store.move(ids, toDone: true) } } label: { Label("Sweep", systemImage: "checkmark") }
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(MailWord(key: b.colorKey))
                    .buttonStyle(.borderless)
                    .padding(.leading, 20)
                    .help("Mark \(ids.count) done (pinned mail stays)")
                    .accessibilityLabel("Sweep \(b.name): mark \(ids.count) done, pinned mail stays")
            }
            ForEach(mails, id: \.key) { t in threadRow(t).padding(.leading, 20) }
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

    /// New mail: its writing box, in the reading pane on the Mac (the mail picked there gives way to it), in a sheet on
    /// the iPhone and iPad. What was typed before is there again.
    private func newMail() {
        newMailPressed = true
        #if os(macOS)
        selection = []
        MailWriting.shared.open[Mail.newMailKey] = .new
        #endif
        composingNew = true
    }

    /// A tap (or Return) on a row: a thread opens, a bundle opens or closes in place, a reminder opens its task.
    private func openRow(_ id: String) {
        if id.hasPrefix("bundle:") {
            let key = String(id.dropFirst("bundle:".count))
            withAnimation(.snappy(duration: 0.2)) { if openBundles.contains(key) { openBundles.remove(key) } else { openBundles.insert(key) } }
        } else if id.hasPrefix("rem:") {
            model.open(itemId: String(id.dropFirst("rem:".count)))
        } else if id.hasPrefix("hit:") {
            if !isMac { opened = OpenThread(id: String(id.dropFirst("hit:".count)), hit: true) }
        } else if id.hasPrefix("folder:") {
            if !isMac, let f = folder { opened = OpenThread(id: String(id.dropFirst("folder:".count)), folder: f.key) }
        } else if !isMac {
            opened = OpenThread(id: id)
        }
    }

    /// The folder's mail selected (one at a time: its actions are each one's own).
    private var chosenFolderMail: MailFolderMail? {
        guard selection.count == 1, let id = selection.first, id.hasPrefix("folder:"), let f = folder else { return nil }
        return store.folderMail[f.key]?.first { $0.id == id.dropFirst("folder:".count) }
    }

    /// On the Mac a click selects: a bundle or reminder row acts at once and is not kept selected, and a folder's mail
    /// is selected one at a time.
    private func takeRowTaps(_ s: Set<String>) {
        guard isMac, s.count == 1, let id = s.first, id.hasPrefix("bundle:") || id.hasPrefix("rem:") else {
            var kept = s.filter { !$0.hasPrefix("bundle:") && !$0.hasPrefix("rem:") }
            if kept.count > 1 { kept = kept.filter { !$0.hasPrefix("folder:") && !$0.hasPrefix("hit:") } }
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
            let sweep = store.sweepIds(bundleRowMails(String(id.dropFirst("bundle:".count))))
            if !sweep.isEmpty {
                Button("Sweep (mark \(sweep.count) done)", systemImage: "checkmark") { Task { await store.move(sweep, toDone: true) } }
            }
        } else if ids.count == 1, let id = ids.first, id.hasPrefix("folder:"), let f = folder,
                  let m = store.folderMail[f.key]?.first(where: { $0.id == id.dropFirst("folder:".count) }) {
            MailFolderActions(store: store, mail: m, folder: f) { selection = [] }
        } else if !ts.isEmpty {
            actionButtons(ts)
            #if os(iOS)
            if editMode == .inactive {
                Button("Select", systemImage: "checkmark.circle") { editMode = .active; selection = Set(ts.map(\.key)) }
            }
            #endif
        }
    }

    /// Done (or Move to Inbox), Snooze, Pin, Mark read and Mark unread for threads: a row's menu.
    @ViewBuilder private func actionButtons(_ ts: [MailThread]) -> some View {
        let inDone = ts.allSatisfy { $0.state == .done }
        // A Read only mailbox's mail takes no Done, Pin or move: offered only when some of it is in another mailbox.
        let writable = ts.contains { !store.readOnly($0) }
        if writable {
            Button(inDone ? "Move to Inbox" : "Done", systemImage: inDone ? "tray" : "checkmark") {
                Task { await store.done(ts, inDone: inDone); selection = [] }
            }
        }
        if !inDone {
            Button("Snooze", systemImage: "clock") { snoozing = SnoozeTarget(threads: ts.filter { $0.state != .done }) }
        }
        if ts.count == 1, let t = ts.first, t.state == .snoozed {
            Button("Unsnooze", systemImage: "tray") { Task { await store.unsnooze(t) } }
        }
        if writable {
            Button(ts.allSatisfy(\.pinned) ? "Unpin" : "Pin", systemImage: "pin") { Task { await store.pin(ts) } }
        }
        Button("Mark read", systemImage: "envelope.open") { Task { await store.read(ts, true) } }
        Button("Mark unread", systemImage: "envelope.badge") { Task { await store.read(ts, false) } }
        if writable {
            Divider()
            MailMoveButtons(store: store, threads: ts) { selection = [] }
        }
    }

    /// Delete or Spam for the selection (threads), or Delete for a folder's mail where its folder can undo it.
    private func moveChosen(_ to: String) -> Bool {
        let ts = chosen
        if !ts.isEmpty {
            let ids = ts.flatMap { $0.openIds + $0.doneIds }
            Task { await store.relocate(ids, to: to, said: to == "trash" ? "Moved to Trash" : "Moved to Spam", back: "inbox") { selection = [] } }
            return true
        }
        if to == "trash", let m = chosenFolderMail, let f = folder {
            if store.readOnly(mailbox: f.email) { store.actionError = Mail.readOnlyText(f.email); return true }
            let can = Mail.folderActs(f.role)
            guard can.trash && can.undo else { return true }
            Task { await store.relocate([m.id], to: "trash", said: "Moved to Trash", back: Mail.moveTarget(f)) { selection = [] } }
            return true
        }
        return false
    }

    // MARK: Keys (iPad and Mac keyboards)

    private func keyPress(_ press: KeyPress) -> KeyPress.Result {
        let name: String
        switch press.key {
        case .escape: name = "escape"
        case .return: name = "return"
        case .delete: name = "delete"
        case .deleteForward: name = "deleteForward"
        default: name = press.characters
        }
        guard let a = Mail.keyAction(name, control: press.modifiers.contains(.control), command: press.modifiers.contains(.command), option: press.modifiers.contains(.option)) else { return .ignored }
        let ts = chosen
        switch a {
        case .escape:
            guard !selection.isEmpty else { return .ignored }
            selection = []
        case .search: searchFocused = true
        case .help: showKeys = true
        case .open, .select: return .ignored
        case .done: guard !ts.isEmpty else { return .ignored }; Task { await store.done(ts, inDone: place == .done); selection = [] }
        case .snooze: guard !ts.isEmpty, place != .done else { return .ignored }; snoozing = SnoozeTarget(threads: ts)
        case .pin: guard !ts.isEmpty else { return .ignored }; Task { await store.pin(ts) }
        case .read, .unread: guard !ts.isEmpty else { return .ignored }; Task { await store.read(ts, a == .read) }
        case .delete: return moveChosen("trash") ? .handled : .ignored
        case .spam: return !ts.isEmpty && moveChosen("junk") ? .handled : .ignored
        }
        return .handled
    }

    // MARK: Toolbar and places

    /// Unread mail the Inbox lists now, counted as the list shows it: mail of a bundle this app has no view for is not held back.
    private var inboxUnread: Int {
        let held = Mail.shownDelivery(store.delivery, shown: shown)
        return store.threads.filter { $0.state == .inbox && $0.isUnread && Mail.inboxAt($0.summary, delivery: held, now: clock) != nil }.count
    }
    private var snoozedCount: Int { store.threads.filter { $0.state == .snoozed }.count }
    private func bundleUnread(_ b: Mail.Bundle) -> Int { store.threads.filter { $0.state == .inbox && $0.summary.bundle == b.id && $0.isUnread }.count }

    /// The mail of one bundle row in the Inbox (`<day>:<bundle>`), as listed.
    private func bundleRowMails(_ key: String) -> [MailThread] {
        for s in Mail.inboxSections(threads, shown: shown, pinnedOnly: pinnedOnly, now: clock, delivery: store.delivery) {
            for r in s.rows { if case .bundle(let b, let ms) = r, "\(s.title):\(b.id)" == key { return ms } }
        }
        return []
    }

    @ViewBuilder private var placeMenu: some View {
        let unread = inboxUnread
        let snoozed = snoozedCount
        Button { place = .inbox } label: { Label(unread > 0 ? "Inbox (\(unread) new)" : "Inbox", systemImage: "tray") }
        Button { place = .snoozed } label: { Label(snoozed > 0 ? "Snoozed (\(snoozed))" : "Snoozed", systemImage: "clock") }
        Button { place = .done } label: { Label("Done", systemImage: "checkmark") }
        // The other folders, between Done and the bundles: Drafts, Sent, Spam, Trash, then the owner's own.
        ForEach(Mail.folderGroups(store.list?.folders ?? [], boxes: store.boxes), id: \.email) { g in
            SwiftUI.Section(store.boxes.count > 1 ? g.email : "Folders") {
                ForEach(g.folders) { f in
                    let n = Mail.folderCount(f)
                    Button { place = .folder(f.key) } label: { Label(n > 0 ? "\(Mail.folderLabel(f)) (\(n))" : Mail.folderLabel(f), systemImage: f.role.symbol) }
                }
            }
        }
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
            let n = bundleUnread(b)
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
                selectAllButton
                Text("\(chosen.count) selected")
                Button { Task { await store.done(chosen, inDone: place == .done); selection = [] } } label: {
                    Label(place == .done ? "Move to Inbox" : "Done", systemImage: place == .done ? "tray" : "checkmark")
                }
                if place != .done { Button { snoozing = SnoozeTarget(threads: chosen) } label: { Label("Snooze", systemImage: "clock") } }
                Button { Task { await store.pin(chosen) } } label: { Label(chosen.allSatisfy(\.pinned) ? "Unpin" : "Pin", systemImage: "pin") }
                Button { Task { await store.read(chosen, true) } } label: { Label("Mark read", systemImage: "envelope.open") }
                Button { Task { await store.read(chosen, false) } } label: { Label("Mark unread", systemImage: "envelope.badge") }
                Button { _ = moveChosen("trash") } label: { Label("Delete", systemImage: "trash") }
                Button { _ = moveChosen("junk") } label: { Label("Spam", systemImage: "xmark.shield") }
            }
        }
        #endif
    }

    /// Pinned only (in the Inbox), Refresh and the rest. On the iPhone the bar has room for the title, Pinned only and
    /// one menu, so Refresh (also a pull on the list) and Select are in the menu.
    @ToolbarContentBuilder private var commonItems: some ToolbarContent {
        ToolbarItemGroup(placement: .primaryAction) {
            if place == .inbox || here != nil {
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
            // A draft is saved to a mailbox: none while every mailbox is Read only (or none is linked).
            if !Mail.writableBoxes(store.boxes).isEmpty {
                Button { newMail() } label: { Label("New mail", systemImage: "square.and.pencil") }
                    .help(Mail.writableBoxes(store.boxes).contains(where: Mail.canSend) ? "Write a new mail, to send or save as a draft" : "Write a new mail, saved to Drafts in your mailbox")
            }
            Menu {
                #if os(iOS)
                Button { editMode = .active } label: { Label("Select", systemImage: "checkmark.circle") }
                Button { Task { await store.refresh() } } label: { Label(store.refreshing ? "Refreshing" : "Refresh", systemImage: "arrow.clockwise") }
                    .disabled(store.refreshing || engine.client == nil)
                if sizeClass == .regular {
                    Button { showKeys = true } label: { Label("Keyboard keys", systemImage: "keyboard") }
                }
                #endif
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
            selectAllButton.labelStyle(.iconOnly).font(.title3)
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
                Button { _ = moveChosen("trash") } label: { Label("Delete", systemImage: "trash") }
                Button { _ = moveChosen("junk") } label: { Label("Spam", systemImage: "xmark.shield") }
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
    /// The places beside the mail, as the web's side list: Inbox, Snoozed and Done, then the bundles (built in, a
    /// module's, the owner's own) each on its color with its new mail counted, New bundle, and the mailboxes.
    private var macRail: some View {
        List {
            railRow("Inbox", symbol: "tray", key: .place("inbox"), count: inboxUnread, to: .inbox)
            railRow("Snoozed", symbol: "clock", key: .place("snoozed"), count: snoozedCount, to: .snoozed)
            railRow("Done", symbol: "checkmark", key: .place("done"), count: 0, to: .done)
            // The other folders, between Done and the bundles; with several mailboxes under each one's address.
            ForEach(Mail.folderGroups(store.list?.folders ?? [], boxes: store.boxes), id: \.email) { g in
                if store.boxes.count > 1 {
                    SwiftUI.Section { ForEach(g.folders) { f in folderRailRow(f, many: true) } } header: { Text(verbatim: g.email).lineLimit(1).help(g.email) }
                } else {
                    ForEach(g.folders) { f in folderRailRow(f, many: false) }
                }
            }
            SwiftUI.Section("Bundles") {
                ForEach(shown.filter { $0.module == nil && $0.custom == nil }) { b in railRow(b) }
            }
            if shown.contains(where: { $0.module != nil }) {
                SwiftUI.Section("From your modules") {
                    ForEach(shown.filter { $0.module != nil }) { b in railRow(b) }
                }
            }
            SwiftUI.Section("Your bundles") {
                ForEach(shown.filter { $0.custom != nil }) { b in railRow(b) }
                Button { editing = BundleEdit(start: nil) } label: { Label("New bundle", systemImage: "plus") }
                    .buttonStyle(.plain)
            }
            SwiftUI.Section {
                Button { showKeys = true } label: { Label("Keyboard keys", systemImage: "keyboard") }
                    .buttonStyle(.plain)
                let trouble = store.list?.mailboxes.contains { $0.last_error != nil } == true
                Button { showSettings = true } label: {
                    Label(trouble ? "Mailboxes and settings (a mailbox has a problem)" : "Mailboxes and settings", systemImage: trouble ? "exclamationmark.circle" : "info.circle")
                }
                .buttonStyle(.plain)
            }
        }
        .listStyle(.sidebar)
    }

    private func railRow(_ b: Mail.Bundle) -> some View {
        railRow(b.name, symbol: b.symbol, key: b.colorKey, count: bundleUnread(b), to: .bundle(b.id))
    }

    /// A folder in the side list: its icon, its name (cut with an ellipsis, whole in its tooltip), and its drafts or
    /// unread mail.
    private func folderRailRow(_ f: MailFolder, many: Bool) -> some View {
        railRow(Mail.folderLabel(f), symbol: f.role.symbol, key: .place("folder"), count: Mail.folderCount(f), to: .folder(f.key))
            .help(Mail.folderLabel(f, many: many))
    }

    private func railRow(_ name: String, symbol: String, key: MailColors.Key, count: Int, to: Mail.Place) -> some View {
        let here = place == to
        return Button { place = to } label: {
            HStack(spacing: 8) {
                RoundedRectangle(cornerRadius: 5)
                    .fill(MailFill(key: key))
                    .overlay(Image(systemName: symbol).font(.system(size: 10, weight: .semibold)).foregroundStyle(.white))
                    .frame(width: 20, height: 20)
                    .accessibilityHidden(true)
                Text(verbatim: name).fontWeight(here ? .semibold : .regular).lineLimit(1)
                Spacer(minLength: 4)
                if count > 0 { Text("\(count)").font(.caption.weight(.semibold)).foregroundStyle(.secondary) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(RoundedRectangle(cornerRadius: 6).fill(MailWord(key: key)).opacity(here ? 0.16 : 0).padding(.horizontal, 6))
        .accessibilityLabel(count > 0 ? "\(name), \(count) new" : name)
        .accessibilityAddTraits(here ? .isSelected : [])
    }

    @ViewBuilder private var macDetail: some View {
        if selection.count == 1, let id = selection.first, store.thread(id) != nil {
            MailThreadView(store: store, id: id, snooze: { snoozing = SnoozeTarget(threads: [$0]) }, closed: { selection = [] }, showPerson: showPerson)
                .id(id)
        } else if selection.count == 1, let id = selection.first, id.hasPrefix("hit:") {
            MailHitView(store: store, id: String(id.dropFirst("hit:".count)), inPersonView: person != nil, showInPlace: showInPlace, showPerson: showPerson)
                .id(id)
        } else if selection.count == 1, let id = selection.first, id.hasPrefix("folder:"), let f = folder {
            MailFolderMailView(store: store, id: String(id.dropFirst("folder:".count)), folder: f) { selection = [] }
                .id(id)
        } else if selection.count > 1 {
            Text("\(chosen.count) selected").font(.title3).foregroundStyle(.secondary)
        } else if composingNew {
            ScrollView {
                // Open from before the screen showed, it does not take the focus.
                MailComposer(store: store, target: .fresh, takesFocus: newMailPressed) { MailWriting.shared.open[Mail.newMailKey] = nil; composingNew = false }
                    .padding()
                    .frame(maxWidth: 820, alignment: .leading)
                    .frame(maxWidth: .infinity)
            }
        } else {
            Text("Pick a mail to read it.").font(.title3).foregroundStyle(.secondary)
        }
    }
    #endif

    // MARK: Simulator and Mac screenshots (Debug builds)

    #if DEBUG
    /// `-EAMailPlace bundle:<id>|snoozed|done` opens that place; `-EAMailOpen <words>` opens the first thread whose
    /// subject has them; `-EAMailSelect <n>` selects the first n threads; `-EAMailBundleOpen YES` opens the first bundle row;
    /// `-EAMailWrite new` opens New mail, and `-EAMailWrite reply` a reply under the thread -EAMailOpen opened (MailProbe).
    private func debugLaunch() async {
        let d = UserDefaults.standard
        if let p = d.string(forKey: "EAMailPlace") {
            place = p == "snoozed" ? .snoozed : p == "done" ? .done : p.hasPrefix("bundle:") ? .bundle(String(p.dropFirst(7))) : .inbox
        }
        for _ in 0..<40 where store.list == nil { try? await Task.sleep(for: .milliseconds(250)) }
        if let words = d.string(forKey: "EAMailOpen"), let t = store.threads.first(where: { $0.summary.subject.localizedCaseInsensitiveContains(words) }) {
            // -EAMailWrite reply: the reply box under it is open when the thread shows.
            if d.string(forKey: "EAMailWrite") == "reply" { MailWriting.shared.open[t.id] = .one }
            if isMac { selection = [t.key] } else { opened = OpenThread(id: t.key) }
        }
        if d.string(forKey: "EAMailWrite") == "new" { newMail() }
        let n = d.integer(forKey: "EAMailSelect")
        if n > 0 {
            #if os(iOS)
            editMode = .active
            #endif
            selection = Set(Mail.viewMessages(store.threads, view: .inbox, shown: shown).filter { $0.summary.bundle == nil || $0.pinned }.prefix(n).map(\.key))
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
