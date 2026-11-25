import SwiftUI
import EACore

// The mailboxes' other folders (Drafts, Sent, Spam, Trash and the owner's own) on the Mail screen, as on the web: a
// folder's mail as rows, and a folder's mail open with what its folder lets it do. Delete, Spam, Not spam and Move to
// move mail in the mailbox (never erase it), each with an Undo where the mail can go back.

/// A folder's mail as a row: who (those it went to, for the owner's own in Sent and Drafts), the subject and first
/// words, when, unread in bold with a dot, and a paperclip when it has attachments.
struct MailFolderRow: View {
    var mail: MailFolderMail

    var body: some View {
        let s = mail.summary
        let unread = s.seen == false
        HStack(alignment: .top, spacing: 10) {
            Circle()
                .fill(unread ? AnyShapeStyle(MailWord(key: .place("inbox"))) : AnyShapeStyle(Color.clear))
                .frame(width: 8, height: 8)
                .padding(.top, 15)
                .accessibilityHidden(true)
            Circle().fill(Color.secondary.opacity(0.22))
                .overlay(Text(verbatim: Mail.initials(mail.isOwners ? mail.to.first ?? s.from : s.from)).font(.system(size: 14, weight: .semibold)))
                .frame(width: 38, height: 38)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(verbatim: Mail.folderWho(mail)).fontWeight(unread ? .bold : .regular).lineLimit(1)
                    if let n = s.attachments {
                        Image(systemName: "paperclip").font(.caption).foregroundStyle(.secondary)
                            .accessibilityLabel(n == 1 ? "An attachment" : "\(n) attachments")
                    }
                    Spacer(minLength: 6)
                    Text(verbatim: Mail.whenLabel(s.at)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Text(verbatim: s.subject.isEmpty ? "(no subject)" : s.subject).font(.subheadline).fontWeight(unread ? .semibold : .regular).lineLimit(1)
                if !s.preview.isEmpty { Text(verbatim: s.preview).font(.subheadline).foregroundStyle(.secondary).lineLimit(2) }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityHint(unread ? "Unread" : "")
    }
}

/// A folder's mail open: its sender (and for what the owner wrote, who it went to), what its folder lets it do
/// (MailFolderActions), Forward, Edit for a draft, then the message as in the Inbox (its own words, the page as sent
/// without web pictures, which the hub never fetches for a folder's mail). On the Mac in place in the list (`inline`).
struct MailFolderMailView: View {
    @ObservedObject var store: MailStore
    var id: String
    var folder: MailFolder
    /// In place in the list (the Mac): no scrolling of its own, no title, and its heading closes it.
    var inline = false
    /// The mail left the folder (moved), or its heading was pressed in place: the screen goes back to the list.
    var closed: () -> Void
    @Environment(\.dismiss) private var dismiss
    /// The writing box shown (Forward, or Edit for a draft): open again when it was open before, and kept until Close
    /// once saved.
    @State private var box: MailWriting.Box?

    init(store: MailStore, id: String, folder: MailFolder, inline: Bool = false, closed: @escaping () -> Void) {
        self.store = store
        self.id = id
        self.folder = folder
        self.inline = inline
        self.closed = closed
        _box = State(initialValue: MailWriting.shared.open[id])
    }

    private func setBox(_ k: MailWriting.Box?) { MailWriting.shared.open[id] = k; box = k }

    var body: some View {
        Group {
            if let m = store.folderMail[folder.key]?.first(where: { $0.id == id }) {
                if inline {
                    content(m)
                } else {
                    ScrollView {
                        content(m)
                            .padding()
                            .frame(maxWidth: 820, alignment: .leading)
                            .frame(maxWidth: .infinity)
                    }
                }
            } else {
                MailEmpty(title: "Not here any more", text: "This mail left the folder you opened it from.")
            }
        }
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        .mailMoveQuestion(store)
        #endif
        .modifier(MailPageTitle(title: Mail.folderLabel(folder), shown: !inline))
    }

    private func content(_ m: MailFolderMail) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            MailOpenHeading(inline: inline, close: closed) { header(m) }
            // A Read only mailbox takes no move, and no draft (a forward, an edit) is saved to it.
            let ro = store.readOnly(mailbox: folder.email)
            FlowLayout(spacing: 8) {
                MailFolderActions(store: store, mail: m, folder: folder) { leave() }
                if !ro {
                    boxButton(.forward, "Forward", "arrowshape.turn.up.right")
                    if folder.role == .drafts { boxButton(.draft, "Edit", "pencil") }
                }
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            if folder.role == .trash {
                Text("Mail in Trash is erased only from \(Mail.mailApp(Mail.mailboxOf(store.boxes, folder.email))).").font(.footnote).foregroundStyle(.secondary)
            }
            if ro {
                EmptyView()
            } else if box == .forward {
                MailComposer(store: store, target: .forward(m.summary, mailbox: folder.email)) { setBox(nil) }
            } else if box == .draft, folder.role == .drafts {
                MailComposer(store: store, target: .draft(m, email: folder.email)) { setBox(nil) }
            }
            if m.folder_role == .junk {
                Text("This mail is in Spam. Be careful with its links, and never sign in or pay through them.")
                    .font(.footnote).foregroundStyle(.warnText)
            }
            MailMessageBody(store: store, mail: m.summary)
        }
    }

    private func header(_ m: MailFolderMail) -> some View {
        let s = m.summary
        return HStack(alignment: .top, spacing: 12) {
            Circle().fill(Color.secondary.opacity(0.22))
                .overlay(Text(verbatim: Mail.initials(m.isOwners ? m.to.first ?? s.from : s.from)).font(.system(size: 17, weight: .semibold)))
                .frame(width: 44, height: 44)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(verbatim: s.subject.isEmpty ? "(no subject)" : s.subject).font(.title3.weight(.semibold)).mailSelectable(!inline)
                // The real addresses, always: a display name can say anything.
                if m.isOwners {
                    let to = m.to.map { "\(Mail.personLabel($0)) <\($0.address)>" }.joined(separator: ", ")
                    Text(verbatim: "To \(to.isEmpty ? "no one yet" : to)").font(.subheadline).mailSelectable(!inline)
                } else {
                    Text(verbatim: "\(Mail.personLabel(s.from)) <\(s.from.address)>").font(.subheadline).mailSelectable(!inline)
                }
                Text(verbatim: ISO.date(s.at)?.shortDateTime ?? "").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    /// Forward, or Edit for a draft: its writing box under the actions, open again when it was open before.
    private func boxButton(_ k: MailWriting.Box, _ label: String, _ symbol: String) -> some View {
        let on = box == k
        return Button { setBox(on ? nil : k) } label: { Label(label, systemImage: symbol) }
            .tint(on ? MailFill(key: .place("inbox")) : nil)
            .accessibilityAddTraits(on ? .isSelected : [])
    }

    private func leave() {
        closed()
        #if os(iOS)
        dismiss()
        #endif
    }
}

/// A folder mail's actions, by its folder (Mail.folderActs): Spam has Not spam and Delete; Trash has Move to Inbox;
/// the owner's folders have Move to Inbox, Delete and Move to another folder of the same mailbox; Sent and Drafts have
/// Delete (no Undo: nothing is moved into Sent or Drafts).
struct MailFolderActions: View {
    @ObservedObject var store: MailStore
    var mail: MailFolderMail
    var folder: MailFolder
    /// The mail moved away.
    var moved: () -> Void = {}

    var body: some View {
        let can = Mail.folderActs(folder.role)
        let here = Mail.moveTarget(folder)
        let box = Mail.mailboxOf(store.boxes, folder.email)
        if box?.read_only == true {
            Text("Read only: Aeneas changes nothing in this mailbox.").font(.footnote).foregroundStyle(.secondary)
        } else {
            moves(can, here, box)
        }
    }

    @ViewBuilder private func moves(_ can: Mail.FolderActs, _ here: String, _ box: MailMailbox?) -> some View {
        if can.inbox {
            Button { go("inbox", "Moved to Inbox", here) } label: { Label(folder.role == .junk ? "Not spam" : "Move to Inbox", systemImage: "tray") }
        }
        if can.trash {
            Button { go("trash", "Moved to Trash", can.undo ? here : nil) } label: { Label("Delete", systemImage: "trash") }
                .help("Delete: moves it to Trash \(Mail.inProvider(box))")
        }
        let others = can.move ? Mail.moveFolders(store.list?.folders ?? [], mailboxes: [folder.email], except: folder.key) : []
        if !others.isEmpty {
            Menu {
                ForEach(others) { f in Button(Mail.folderLabel(f)) { go(f.key, "Moved to \(Mail.folderLabel(f))", here) } }
            } label: { Label("Move to", systemImage: "folder") }
            .fixedSize()
        }
    }

    private func go(_ to: String, _ said: String, _ back: String?) {
        Task { await store.relocate([mail.id], to: to, said: said, back: back, done: moved) }
    }
}

/// Delete, Spam and Move to one of the owner's folders, for threads in the Inbox, Snoozed or Done; Undo sends them back.
/// Only the folders of the mailbox the mail is in are offered (none for mail of several mailboxes).
struct MailMoveButtons: View {
    @ObservedObject var store: MailStore
    var threads: [MailThread]
    var delete = true
    var spam = true
    var move = true
    /// The mail moved away.
    var moved: () -> Void = {}

    var body: some View {
        // None for a Read only mailbox's mail (with others, those are left out of the move, and said so).
        if threads.contains(where: { !store.readOnly($0) }) { buttons }
    }

    @ViewBuilder private var buttons: some View {
        let ids = threads.flatMap { $0.openIds + $0.doneIds }
        let one = Set(threads.map { $0.summary.mailbox?.lowercased() }).count == 1
        let box = one ? Mail.mailboxOf(store.boxes, threads.first?.summary.mailbox) : nil
        let own = Mail.moveFolders(store.list?.folders ?? [], mailboxes: threads.map(\.summary.mailbox))
        if delete {
            Button { go(ids, "trash", "Moved to Trash") } label: { Label("Delete", systemImage: "trash") }
                .help("Delete: moves it to Trash \(Mail.inProvider(box))")
        }
        if spam {
            Button { go(ids, "junk", "Moved to Spam") } label: { Label("Spam", systemImage: "xmark.shield") }
                .help("Spam: moves it to Spam (Junk) \(Mail.inProvider(box))")
        }
        if move && !own.isEmpty {
            Menu {
                ForEach(own) { f in Button(Mail.folderLabel(f)) { go(ids, f.key, "Moved to \(Mail.folderLabel(f))") } }
            } label: { Label("Move to", systemImage: "folder") }
            .fixedSize()
        }
    }

    private func go(_ ids: [String], _ to: String, _ said: String) {
        Task { await store.relocate(ids, to: to, said: said, back: "inbox", done: moved) }
    }
}

extension View {
    /// The question before mail is moved while something written under it is not saved to Drafts.
    func mailMoveQuestion(_ store: MailStore, when shown: Bool = true) -> some View {
        modifier(MailMoveQuestion(store: store, shown: shown))
    }
}

private struct MailMoveQuestion: ViewModifier {
    @ObservedObject var store: MailStore
    var shown: Bool

    func body(content: Content) -> some View {
        content.confirmationDialog("What you wrote here is not saved to Drafts. Move the mail and discard what you wrote?",
                                   isPresented: Binding(get: { shown && store.askMove != nil }, set: { if !$0 { store.askMove = nil } }), titleVisibility: .visible) {
            Button("Move and discard", role: .destructive) {
                guard let m = store.askMove else { return }
                store.askMove = nil
                Task { await store.relocate(m.ids, to: m.to, said: m.said, back: m.back, confirmed: true, done: m.done) }
            }
        }
    }
}

/// Unsubscribe and Block for a mail's sender, as on the web. Unsubscribe reads the mail's own ways now and says what
/// each does: one click through Tor, or (a hub without Tor) only after the owner accepts that the sender sees the
/// home's address; the sender's own page, opened in the browser with its host shown; or a mail to their unsubscribe
/// address, shown whole and then sent with its Undo (MailUnsubscribeByMail) or, from a mailbox without a sending
/// server, saved to Drafts. Block sends the sender's (or their domain's) mail to Spam, now and from now on; its Undo
/// unblocks and moves that mail back. A block the hub refuses shows the hub's sentence.
struct MailSenderToolsSheet: View {
    @ObservedObject var store: MailStore
    var mail: MailSummary
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var ways: MailUnsubscribeOptions?
    @State private var msg: String?
    @State private var err: String?
    @State private var busy = false
    @State private var direct = false

    private var app: String { Mail.mailApp(Mail.mailboxOf(store.boxes, mail.mailbox)) }
    private var domain: String { mail.from.address.split(separator: "@").last.map(String.init) ?? "" }

    var body: some View {
        NavigationStack {
            Form {
                SwiftUI.Section("Unsubscribe") {
                    if ways == nil && err == nil {
                        Text("Reading the mail's unsubscribe links").foregroundStyle(.secondary)
                    }
                    if let w = ways, w.one_click == nil, w.link == nil, w.mailto == nil {
                        Text("This mail has no unsubscribe link. You can block the sender instead.").foregroundStyle(.secondary)
                    }
                    if let w = ways, let one = w.one_click {
                        VStack(alignment: .leading, spacing: 6) {
                            if w.tor || direct {
                                Button("Unsubscribe") {
                                    run {
                                        let r = try await store.unsubscribe(mail.id, how: "one_click", direct: !w.tor)
                                        return r.via == "tor" ? "Unsubscribed, through Tor." : "Unsubscribed."
                                    }
                                }
                                .buttonStyle(.borderedProminent).disabled(busy)
                            } else {
                                Button("Unsubscribe\u{2026}") { direct = true }.disabled(busy)
                            }
                            Text(verbatim: w.tor ? "Your hub tells \(one.host) through Tor, so it does not see your home's internet address."
                                 : direct ? "Your hub will contact \(one.host), which then sees your home's internet address. Press Unsubscribe to go ahead."
                                 : "One click: your hub contacts \(one.host).")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                    if let w = ways, let link = w.link, let l = Mail.httpsLink(link), let url = URL(string: l.href) {
                        VStack(alignment: .leading, spacing: 6) {
                            Button("Open their unsubscribe page") { openURL(url) }
                            Text(verbatim: "Opens \(l.host) in your browser.").font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                    // The unsubscribe mail is sent from a mailbox that sends, else saved to Drafts: none for a Read only one.
                    if let w = ways, let to = w.mailto, !store.readOnly(mailbox: mail.mailbox) {
                        if let box = Mail.mailboxOf(store.boxes, mail.mailbox), Mail.canSend(box) {
                            MailUnsubscribeByMail(store: store, mail: mail, from: box.email, to: to.to, subject: to.subject ?? "unsubscribe")
                        } else {
                            VStack(alignment: .leading, spacing: 6) {
                                Button(Mail.UnsubscribeTexts.write) {
                                    run {
                                        _ = try await store.unsubscribe(mail.id, how: "mailto")
                                        return "A mail to \(to.to) is in Drafts: send it from \(app)."
                                    }
                                }
                                .disabled(busy)
                                Text(verbatim: Mail.unsubscribeNote(to: to.to, sends: false)).font(.footnote).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                SwiftUI.Section("Block") {
                    Button("Block \(mail.from.address)") { block(mail.from.address, who: mail.from.address) }.disabled(busy)
                    if !domain.isEmpty {
                        Button("Block everyone at \(domain)") { block("@\(domain)", who: "everyone at \(domain)") }.disabled(busy)
                    }
                    Text("Their mail goes to Spam, now and from now on.").font(.footnote).foregroundStyle(.secondary)
                }
                if let msg { Text(verbatim: msg) }
                if let err { Text(verbatim: err).foregroundStyle(.dangerText) }
            }
            .formStyle(.grouped)
            .navigationTitle("Unsubscribe or block")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Close") { dismiss() } } }
        }
        .task {
            do { ways = try await store.unsubscribeOptions(mail.id) } catch { err = error.localizedDescription }
        }
        #if os(macOS)
        .frame(minWidth: 460, minHeight: 420)
        #else
        .presentationDetents([.medium, .large])
        #endif
    }

    private func run(_ f: @escaping () async throws -> String) {
        busy = true; err = nil; msg = nil
        Task {
            do { msg = try await f() } catch { err = error.localizedDescription }
            busy = false
        }
    }

    private func block(_ sender: String, who: String) {
        run { try await store.block(sender, who: who) }
    }
}

/// Unsubscribe by mail from a mailbox that sends (since 2026-11-24), as on the web: the button shows the whole mail
/// (from the mailbox the mail is in, to the address its header gives, the header's subject and the word
/// "unsubscribe"); Send puts it in the hub's outbox, and it then shows as a writing box shows a sent mail: Sending with
/// Undo while it waits, Sent, or Not sent with the hub's words, Try again, Save draft and Discard (asked first).
struct MailUnsubscribeByMail: View {
    @ObservedObject var store: MailStore
    var mail: MailSummary
    var from: String
    var to: String
    var subject: String
    @State private var asking = false
    @State private var outboxId: String?
    @State private var item: MailOutboxItem?
    @State private var busy = false
    @State private var err: String?
    @State private var looks = 0
    @State private var askDiscard = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let id = outboxId {
                switch Mail.outboxFace(item ?? MailOutboxItem(id: id)) {
                case .sent, .gone:
                    Text(verbatim: Mail.unsubscribeSent(to: to))
                case .failed(let why):
                    Text(Mail.SendTexts.failed).font(.headline)
                    Text(verbatim: why).font(.footnote).foregroundStyle(.dangerText)
                    FlowLayout(spacing: 10) {
                        Button("Try again") { act { item = try await store.retrySend(id); looks += 1 } }.buttonStyle(.borderedProminent).disabled(busy)
                        Button("Save draft") { act { try await store.draftFromOutbox(id); outboxId = nil; item = nil; await store.load() } }.buttonStyle(.bordered).disabled(busy)
                        Button("Discard") { askDiscard = true }.buttonStyle(.bordered).disabled(busy)
                    }
                case .sending(let undo):
                    HStack(spacing: 12) {
                        ProgressView()
                        VStack(alignment: .leading, spacing: 2) {
                            Text(Mail.SendTexts.sending).font(.headline)
                            Text(verbatim: "To \(to)").font(.footnote).foregroundStyle(.secondary).lineLimit(2)
                        }
                        Spacer(minLength: 8)
                        if undo {
                            Button("Undo") { act { try await store.takeBack(id); outboxId = nil; item = nil } }.buttonStyle(.borderedProminent).disabled(busy)
                        }
                    }
                }
            } else if asking {
                Text(Mail.UnsubscribeTexts.confirm).font(.footnote).foregroundStyle(.secondary)
                Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 4) {
                    GridRow { Text("From").foregroundStyle(.secondary); Text(verbatim: from) }
                    GridRow { Text("To").foregroundStyle(.secondary); Text(verbatim: to) }
                    GridRow { Text("Subject").foregroundStyle(.secondary); Text(verbatim: subject) }
                }
                .font(.footnote)
                Text(Mail.UnsubscribeTexts.text)
                FlowLayout(spacing: 10) {
                    Button("Send") {
                        act {
                            let got = try await store.unsubscribeSend(mail.id)
                            item = got
                            outboxId = got.id
                            asking = false
                        }
                    }
                    .buttonStyle(.borderedProminent).disabled(busy)
                    Button("Cancel") { asking = false }.buttonStyle(.bordered).disabled(busy)
                }
            } else {
                Button(Mail.UnsubscribeTexts.send) { err = nil; asking = true }
                Text(verbatim: Mail.unsubscribeNote(to: to, sends: true)).font(.footnote).foregroundStyle(.secondary)
            }
            if let err { Text(verbatim: err).font(.footnote).foregroundStyle(.dangerText) }
        }
        .task(id: "\(outboxId ?? "")#\(looks)") { await watch() }
        .confirmationDialog(Mail.SendTexts.discard, isPresented: $askDiscard, titleVisibility: .visible) {
            Button("Discard", role: .destructive) { if let id = outboxId { act { try await store.takeBack(id); outboxId = nil; item = nil; await store.load() } } }
        }
    }

    /// While the mail waits or is on its way: asked every second. Gone (taken back on another device): the button again.
    private func watch() async {
        guard let id = outboxId else { return }
        while !Task.isCancelled {
            do {
                guard let got = try await store.outboxItem(id) else { outboxId = nil; item = nil; return }
                item = got
                if got.state == "sent" || got.state == "failed" { await store.load(); return }
            } catch {
                // Out of reach for a moment: asked again.
            }
            try? await Task.sleep(for: .seconds(1))
        }
    }

    private func act(_ f: @escaping () async throws -> Void) {
        busy = true; err = nil
        Task {
            do { try await f() } catch { err = error.localizedDescription }
            busy = false
        }
    }
}
