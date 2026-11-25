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
/// without web pictures, which the hub never fetches for a folder's mail).
struct MailFolderMailView: View {
    @ObservedObject var store: MailStore
    var id: String
    var folder: MailFolder
    /// The mail left the folder (moved): the screen goes back to the list.
    var closed: () -> Void
    @Environment(\.dismiss) private var dismiss
    /// The writing box shown (Forward, or Edit for a draft): open again when it was open before, and kept until Close
    /// once saved.
    @State private var box: MailWriting.Box?

    init(store: MailStore, id: String, folder: MailFolder, closed: @escaping () -> Void) {
        self.store = store
        self.id = id
        self.folder = folder
        self.closed = closed
        _box = State(initialValue: MailWriting.shared.open[id])
    }

    private func setBox(_ k: MailWriting.Box?) { MailWriting.shared.open[id] = k; box = k }

    var body: some View {
        Group {
            if let m = store.folderMail[folder.key]?.first(where: { $0.id == id }) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        header(m)
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
                    .padding()
                    .frame(maxWidth: 820, alignment: .leading)
                    .frame(maxWidth: .infinity)
                }
            } else {
                MailEmpty(title: "Not here any more", text: "This mail left the folder you opened it from.")
            }
        }
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        .mailMoveQuestion(store)
        #endif
        .navigationTitle(Mail.folderLabel(folder))
    }

    private func header(_ m: MailFolderMail) -> some View {
        let s = m.summary
        return HStack(alignment: .top, spacing: 12) {
            Circle().fill(Color.secondary.opacity(0.22))
                .overlay(Text(verbatim: Mail.initials(m.isOwners ? m.to.first ?? s.from : s.from)).font(.system(size: 17, weight: .semibold)))
                .frame(width: 44, height: 44)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(verbatim: s.subject.isEmpty ? "(no subject)" : s.subject).font(.title3.weight(.semibold)).textSelection(.enabled)
                // The real addresses, always: a display name can say anything.
                if m.isOwners {
                    let to = m.to.map { "\(Mail.personLabel($0)) <\($0.address)>" }.joined(separator: ", ")
                    Text(verbatim: "To \(to.isEmpty ? "no one yet" : to)").font(.subheadline).textSelection(.enabled)
                } else {
                    Text(verbatim: "\(Mail.personLabel(s.from)) <\(s.from.address)>").font(.subheadline).textSelection(.enabled)
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
/// home's address; the sender's own page, opened in the browser with its host shown; or a draft to their unsubscribe
/// address. Block sends the sender's (or their domain's) mail to Spam, now and from now on; its Undo unblocks and moves
/// that mail back. A block the hub refuses shows the hub's sentence.
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
                    // The unsubscribe mail is a draft saved to the mailbox: none for a Read only one.
                    if let w = ways, let to = w.mailto, !store.readOnly(mailbox: mail.mailbox) {
                        VStack(alignment: .leading, spacing: 6) {
                            Button("Write the unsubscribe mail") {
                                run {
                                    _ = try await store.unsubscribe(mail.id, how: "mailto")
                                    return "A mail to \(to.to) is in Drafts: send it from \(app)."
                                }
                            }
                            .disabled(busy)
                            Text(verbatim: "To \(to.to), saved in Drafts for you to send.").font(.footnote).foregroundStyle(.secondary)
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
