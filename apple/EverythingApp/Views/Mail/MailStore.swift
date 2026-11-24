import SwiftUI
import EACore

/// What the Mail screen holds while it shows: the hub's list, the messages opened, and the last action's Undo. In
/// memory only and gone with the screen: nothing of a mail is written on the device, put in Spotlight, a widget, a
/// notification or a log (CONTRACT.md, Mail).
@MainActor
final class MailStore: ObservableObject {
    @Published private(set) var list: MailList?
    /// The list's messages as rows: threads, each read as its newest received mail.
    @Published private(set) var threads: [MailThread] = []
    @Published private(set) var loadError: String?
    /// The last action's problem, in the hub's words, at the top of the list.
    @Published var actionError: String?
    /// The last Refresh's result, for a few seconds.
    @Published var refreshNote: (ok: Bool, text: String)?
    @Published private(set) var refreshing = false
    /// The last Done, Sweep or Snooze, for its Undo bar (gone after a few seconds, or with the next one).
    @Published var undo: Undo?
    /// Counts the lists that changed: what is fetched with each list (a folder's mail) is fetched again by it.
    @Published private(set) var listStamp = 0
    /// Messages opened, by id, so a thread opened again shows at once.
    @Published private(set) var messages: [String: MailMessage] = [:]

    struct Undo: Identifiable {
        let id = UUID()
        var text: String
        var run: () async -> Void
    }

    private var client: HubClient?
    private var undoTimer: Task<Void, Never>?
    private var noteTimer: Task<Void, Never>?

    func attach(_ c: HubClient?) { client = c }

    var snoozeTimes: MailSnoozeTimes { list?.snooze_times ?? .defaults }
    var delivery: [String: MailBundleDelivery] { list?.bundle_delivery ?? [:] }
    var notify: MailNotify { list?.mail_notify ?? .defaults }
    var customBundles: [MailCustomBundle] { list?.custom_bundles ?? [] }

    /// A thread by its key (MailThread.key), which stays the same while mail comes and goes in it.
    func thread(_ key: String) -> MailThread? { threads.first { $0.key == key } }

    func load() async {
        guard let c = client else { loadError = HubError.notConfigured.localizedDescription; return }
        do {
            let l = try await c.mailList()
            if l != list { list = l; threads = Mail.threads(l.messages); listStamp += 1 }
            loadError = nil
        } catch {
            if list == nil { loadError = error.localizedDescription }
        }
    }

    /// Asks the hub to read the mailboxes now, then shows what came.
    func refresh() async {
        guard let c = client, !refreshing else { return }
        refreshing = true
        refreshNote = nil
        defer { refreshing = false }
        do {
            refreshNote = try await c.mailRefresh().summary
        } catch {
            refreshNote = (false, error.localizedDescription)
        }
        noteTimer?.cancel()
        noteTimer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(6))
            if !Task.isCancelled { self?.refreshNote = nil }
        }
        await load()
    }

    /// Runs one change on the hub, shows its problem if it had one, and loads the list again so every row shows it.
    func act(_ run: (HubClient) async throws -> Void) async {
        guard let c = client else { return }
        actionError = nil
        do { try await run(c) } catch { actionError = error.localizedDescription }
        await load()
    }

    private func offerUndo(_ text: String, _ run: @escaping () async -> Void) {
        undo = Undo(text: text, run: run)
        undoTimer?.cancel()
        undoTimer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(10))
            if !Task.isCancelled { self?.undo = nil }
        }
    }

    /// Done (to Archive in the mailbox) or back to the Inbox, 500 at a time; after Done, an Undo bar.
    func move(_ ids: [String], toDone: Bool) async {
        guard let c = client, !ids.isEmpty else { return }
        actionError = nil
        var moved: [String] = []
        do {
            for part in Mail.batches(ids) {
                let r = toDone ? try await c.mailDone(part) : try await c.mailUndo(part)
                moved += r.moved
                if let e = r.error { actionError = e; break }
            }
        } catch { actionError = error.localizedDescription }
        if toDone, !moved.isEmpty {
            let back = moved
            offerUndo(moved.count == 1 ? "Marked done" : "\(moved.count) marked done") { [weak self] in await self?.move(back, toDone: false) }
        } else if !toDone {
            undo = nil
        }
        await load()
    }

    /// Whether a thread's mailbox is Read only (Settings, Connections): its Done and Pin are held back, as the hub
    /// refuses them.
    func readOnly(_ t: MailThread) -> Bool { Mail.readOnly(list?.mailboxes ?? [], t.summary.mailbox) }

    /// Done for threads, or in Done, back to the Inbox. A Read only mailbox's threads are left as they are, and said so.
    func done(_ ts: [MailThread], inDone: Bool) async {
        let held = ts.filter(readOnly)
        await move(ts.filter { !readOnly($0) }.flatMap { inDone ? $0.doneIds : $0.openIds }, toDone: !inDone)
        if let t = held.first { actionError = Mail.readOnlyText(t.summary.mailbox) }
    }

    /// Sweep: every unpinned thread here marked done at once (pinned ones stay), with one Undo.
    /// A Read only mailbox's mail stays too (Settings, Connections).
    func sweepIds(_ ts: [MailThread]) -> [String] { Mail.sweepIds(ts, boxes: boxes) }

    /// Whether a mailbox (by a mail's `mailbox`) is Read only: the screen offers no change to its mail.
    func readOnly(mailbox: String?) -> Bool { Mail.readOnly(boxes, mailbox) }

    func snooze(_ ts: [MailThread], until: Date) async {
        guard let c = client, !ts.isEmpty else { return }
        actionError = nil
        var done: [MailThread] = []
        do {
            for t in ts where t.state != .done { try await c.mailSnooze(t.id, until: until); done.append(t) }
        } catch { actionError = error.localizedDescription }
        if !done.isEmpty {
            let when = until.formatted(.dateTime.weekday(.abbreviated).hour().minute())
            offerUndo(done.count == 1 ? "Snoozed until \(when)" : "\(done.count) snoozed until \(when)") { [weak self] in
                await self?.act { c in for t in done { try await c.mailUnsnooze(t.id) } }
            }
        }
        await load()
    }

    func unsnooze(_ t: MailThread) async { await act { try await $0.mailUnsnooze(t.id) } }

    /// Pin or unpin: all pinned when any is not.
    func pin(_ ts: [MailThread]) async {
        let to = !ts.allSatisfy(\.pinned)
        // A pin is the mailbox's flag: none in a Read only mailbox.
        let held = ts.filter(readOnly)
        let ids = ts.filter { !readOnly($0) }.map(\.id)
        await act { c in for id in ids { try await c.mailPin(id, pinned: to) } }
        if let t = held.first { actionError = Mail.readOnlyText(t.summary.mailbox) }
    }

    /// Mark read (the threads' unread mail) or unread (each thread's newest received mail), 500 at a time.
    func read(_ ts: [MailThread], _ read: Bool) async {
        let ids = ts.flatMap { read ? $0.unreadIds : [$0.id] }
        guard !ids.isEmpty else { return }
        await act { c in for part in Mail.batches(ids) { try await c.mailSeen(part, seen: read) } }
    }

    /// A message whole, from memory or the hub.
    func message(_ id: String) async throws -> MailMessage {
        if let m = messages[id] { return m }
        guard let c = client else { throw HubError.notConfigured }
        let m = try await c.mailMessage(id)
        messages[id] = m
        return m
    }

    /// Show pictures (a hub without Tor): the hub fetches this mail's pictures now, and the mail comes back with them.
    func showPictures(_ id: String) async throws -> MailMessage {
        guard let c = client else { throw HubError.notConfigured }
        let m = try await c.mailShowPictures(id)
        messages[id] = m
        return m
    }

    // MARK: Folders, moves, unsubscribe and block

    /// Each folder's kept mail as last fetched, by the folder's key (fetched when the folder shows, and again with each
    /// list), and what went wrong fetching one.
    @Published private(set) var folderMail: [String: [MailFolderMail]] = [:]
    @Published private(set) var folderErrors: [String: String] = [:]

    /// One folder's mail, from the hub.
    func loadFolder(_ key: String) async {
        guard let c = client else { return }
        do {
            let ms = try await c.mailFolder(key)
            if folderMail[key] != ms { folderMail[key] = ms }
            folderErrors[key] = nil
        } catch {
            folderErrors[key] = error.localizedDescription
        }
    }

    /// A move waiting for the owner's yes: words written under the mail (a reply, a forward) are not saved to Drafts.
    struct PendingMove {
        var ids: [String]
        var to: String
        var said: String
        var back: String?
        var done: () -> Void
    }
    @Published var askMove: PendingMove?

    /// Delete, Spam, Not spam or Move to (`POST /mail/move`), 500 at a time, with an Undo bar that sends the mail
    /// `back` when it can go back (nil: no Undo, as for Sent and Drafts). Undone, the hub puts the mail back as it was
    /// (in the Inbox, snoozed again or done again). Words written under one of them, or under another mail of its
    /// thread, cannot follow the mail: the owner is asked first (`askMove`), unless `confirmed`. `done` runs once mail
    /// moved (the open mail closes).
    func relocate(_ ids: [String], to: String, said: String, back: String?, undo: Bool = false, confirmed: Bool = false, done: @escaping () -> Void = {}) async {
        guard let c = client, !ids.isEmpty else { return }
        // A Read only mailbox's mail is left where it is, and said so (the hub would refuse it).
        let held = Mail.readOnlyIds(ids, mails: threads.flatMap(\.members) + folderMail.values.flatMap { $0.map(\.summary) }, boxes: boxes)
        let ids = ids.filter { !held.contains($0) }
        if ids.isEmpty {
            if let first = held.first { actionError = Mail.readOnlyText(mailOf(first)?.mailbox) }
            return
        }
        let writing = MailWriting.shared
        let written = Mail.writtenUnder(ids, threads: threads, unsaved: writing.hasUnsaved)
        if !written.isEmpty && !confirmed {
            askMove = PendingMove(ids: ids, to: to, said: said, back: back, done: done)
            return
        }
        actionError = nil
        var moved: [String] = []
        var kept: [String] = []
        do {
            for part in Mail.batches(ids) {
                let r = try await c.mailMove(part, to: to, undo: undo)
                moved += r.moved
                kept += r.moved.compactMap { r.to[$0] }
                if let e = r.error { actionError = e; break }
            }
        } catch { actionError = error.localizedDescription }
        if let first = held.first, actionError == nil { actionError = Mail.readOnlyText(mailOf(first)?.mailbox) }
        if !moved.isEmpty {
            written.forEach(writing.forget)
            // Undo only where the mail can go back, and only for mail the hub knows the new place of.
            if let back, !kept.isEmpty {
                let again = kept
                offerUndo(Mail.movedText(said, count: moved.count)) { [weak self] in await self?.relocate(again, to: back, said: "Moved back", back: nil, undo: true) }
            } else {
                self.undo = nil
            }
            done()
        }
        await load()
    }

    /// A mail the screen holds, by its id: in a thread, or in a folder's list.
    private func mailOf(_ id: String) -> MailSummary? {
        threads.lazy.flatMap(\.members).first { $0.id == id } ?? folderMail.values.lazy.flatMap { $0 }.first { $0.id == id }?.summary
    }

    /// The ways a mail offers to unsubscribe, read from it now; and one of them.
    func unsubscribeOptions(_ id: String) async throws -> MailUnsubscribeOptions {
        guard let c = client else { throw HubError.notConfigured }
        return try await c.mailUnsubscribeOptions(id)
    }

    func unsubscribe(_ id: String, how: String, direct: Bool = false) async throws -> MailUnsubscribed {
        guard let c = client else { throw HubError.notConfigured }
        return try await c.mailUnsubscribe(id, how: how, direct: direct)
    }

    /// Block a sender (an address, or `@domain`): their mail moves to Spam now and at each refresh. The Undo bar says
    /// how many moved and undoes all of it: the sender is unblocked, then the mail that moved is moved back (the hub puts
    /// each one back as it was). What did not move is said above the list; a refused block throws the hub's sentence.
    func block(_ sender: String, who: String) async throws -> String {
        guard let c = client else { throw HubError.notConfigured }
        let r = try await c.mailBlock(sender)
        let u = Mail.blockUndo(r, who: who)
        actionError = r.error
        offerUndo(u.text) { [weak self] in
            await self?.act { c in
                try await c.mailUnblock(sender)
                for part in Mail.batches(u.back) {
                    let one = try await c.mailMove(part, to: "inbox", undo: true)
                    if let e = one.error { throw HubError.http(status: 409, message: e) }
                }
            }
        }
        await load()
        return "Blocked \(who): \(r.moved) moved to Spam, and their new mail goes there too."
    }

    func unblock(_ sender: String) async { await act { try await $0.mailUnblock(sender) } }

    // MARK: Search

    /// What the hub found for the last search (every kept mail with its words, or all mail with one person), each mail
    /// once; nil while it is asked for. `hitsError`: why the search failed.
    @Published private(set) var hits: [MailSearchHit]?
    @Published private(set) var hitsError: String?
    private var hitsFor = ""

    /// Search on the hub. A new search's hits start empty (one person's mail is never shown as another's); the same
    /// search asked again (with a new list) keeps its hits until the answer comes.
    func search(_ q: String, with person: String) async {
        guard let c = client else { return }
        let key = "\(q)\n\(person)"
        if key != hitsFor { hits = nil; hitsError = nil; hitsFor = key }
        do {
            let h = try await c.mailSearch(q, with: person)
            if hitsFor == key { hits = Mail.uniqueHits(h); hitsError = nil }
        } catch {
            if hitsFor == key, !(error is CancellationError) { hitsError = error.localizedDescription }
        }
    }

    func clearHits() { hits = nil; hitsError = nil; hitsFor = "" }
    func hit(_ id: String) -> MailSearchHit? { hits?.first { $0.id == id } }

    // MARK: Sorting new mail and folding notes

    /// Sort new mail: the hub's model runs because the owner asked (it answers at once; the list follows the run).
    func sortNewMail() async { await act { _ = try await $0.mailTriageNow() } }

    /// Triage on or off (off erases every summary the model made).
    func setTriage(_ on: Bool) async { await act { try await $0.mailTriage(on) } }

    /// A folding note on a mail ("Folded too much?"): kept with the mail on the hub. The mail is read again when it
    /// next opens, so one the owner said not to fold shows unfolded.
    func saveFoldNote(_ id: String, lines: [String], noFold: Bool) async throws {
        guard let c = client else { throw HubError.notConfigured }
        try await c.mailFolding(id, lines: lines, noFold: noFold)
        messages[id] = nil
        await load()
    }

    func foldNotes() async -> [MailFoldNoteEntry] { (try? await client?.mailFoldNotes()) ?? [] }
    func clearFoldNotes() async { try? await client?.mailClearFoldNotes() }

    // MARK: Writing and attachments

    /// The linked mailboxes, as the hub lists them.
    var boxes: [MailMailbox] { list?.mailboxes ?? [] }

    /// A draft previewed or saved to the mailbox's Drafts folder (never sent).
    func draft(_ r: MailDraftRequest) async throws -> MailDraft {
        guard let c = client else { throw HubError.notConfigured }
        return try await c.mailDraft(r)
    }

    /// A reply's suggested greeting, sign-off and short replies, from the hub.
    func greeting(_ id: String) async throws -> MailGreeting {
        guard let c = client else { throw HubError.notConfigured }
        return try await c.mailGreeting(id)
    }

    /// An open mail's attachments, read from the mailbox now (with its pictures' previews). Not kept.
    func attachments(_ id: String) async throws -> [MailAttachment] {
        guard let c = client else { throw HubError.notConfigured }
        return try await c.mailAttachments(id)
    }

    /// One attachment's bytes, for the owner to save. Not kept.
    func attachment(_ id: String, part: String) async throws -> Data {
        guard let c = client else { throw HubError.notConfigured }
        return try await c.mailAttachment(id, part: part)
    }

    func setSnoozeTimes(_ t: MailSnoozeTimes) async { await act { _ = try await $0.mailSnoozeTimes(t) } }
    func setDelivery(_ bundle: String, _ d: MailBundleDelivery) async { await act { _ = try await $0.mailBundleDelivery(bundle, d) } }
    func setNotify(people: Bool? = nil, detail: MailNotify.Detail? = nil, bundle: String? = nil, on: Bool? = nil) async {
        await act { _ = try await $0.mailNotify(people: people, detail: detail, bundle: bundle, on: on) }
    }

    /// A bundle of the owner's made or changed; its id, to show it.
    func saveBundle(_ b: MailCustomBundle, isNew: Bool) async throws -> String {
        guard let c = client else { throw HubError.notConfigured }
        let saved = isNew ? try await c.mailBundleAdd(name: b.name, color: b.color, addresses: b.addresses, domains: b.domains, words: b.words)
                          : try await c.mailBundleUpdate(b)
        await load()
        return saved.id
    }

    func deleteBundle(_ id: String) async throws {
        guard let c = client else { throw HubError.notConfigured }
        try await c.mailBundleDelete(id)
        await load()
    }
}
