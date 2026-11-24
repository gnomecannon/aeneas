import SwiftUI
import EACore

/// An open thread: its messages oldest first, the newest and the newest few unread open, the others one tap away. A
/// single mail opens as itself. Opening reads the thread's unread mail, on the hub and in the mailbox (its read flag
/// only), with one request.
struct MailThreadView: View {
    @ObservedObject var store: MailStore
    var id: String
    /// Snooze: the screen's snooze choices for this thread.
    var snooze: (MailThread) -> Void
    /// The thread left (Done, Mark unread): the screen goes back to the list.
    var closed: () -> Void
    /// All mail with one person (from All with), in the list's place.
    var showPerson: ((MailAddress) -> Void)? = nil
    @Environment(\.dismiss) private var dismiss
    /// The unread messages that open by themselves: the newest few, fixed when the thread opens. Each open message is
    /// a page of its own, and a long thread opening all at once is more than a screen should carry.
    @State private var openAtStart: Set<String>?
    /// Unsubscribe or block, for this sender.
    @State private var tools: MailSummary?

    var body: some View {
        Group {
            if let t = store.thread(id) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        header(t)
                        actions(t)
                        if t.state == .snoozed, let u = t.summary.snooze_until, let d = ISO.date(u) {
                            Text("Snoozed until \(d.shortDateTime). It comes back to the top of your Inbox then; its task, called Snoozed mail, is in Tasks and Reminders.")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                        // One mail or many, each is drawn the same way, so a mail (and a reply being written under it)
                        // stays as it is when another arrives in the thread.
                        ForEach(Array(t.members.enumerated()), id: \.element.id) { i, m in
                            MailThreadMessage(store: store, mail: m, single: t.members.count == 1, startOpen: i == t.members.count - 1 || (openAtStart ?? []).contains(m.id))
                            if i < t.members.count - 1 { Divider() }
                        }
                    }
                    .padding()
                    .frame(maxWidth: 820, alignment: .leading)
                    .frame(maxWidth: .infinity)
                }
                .task(id: t.id) {
                    if openAtStart == nil { openAtStart = Set(t.members.filter { Mail.isUnread($0) }.suffix(Mail.openUnreadMax).map(\.id)) }
                    // Only when it opens: Mark unread must not be undone by the screen that is closing.
                    if !t.unreadIds.isEmpty { await store.read([t], true) }
                }
            } else {
                MailEmpty(title: "Not here any more", text: "This mail left the place you opened it from.")
            }
        }
        .sheet(item: $tools) { m in MailSenderToolsSheet(store: store, mail: m) }
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        .mailMoveQuestion(store)
        #endif
        .navigationTitle(store.thread(id).map { $0.summary.subject.isEmpty ? "(no subject)" : $0.summary.subject } ?? "Mail")
    }

    private func header(_ t: MailThread) -> some View {
        HStack(alignment: .top, spacing: 12) {
            MailAvatar(mail: t.summary, logos: store.list?.logos ?? [:], shown: Mail.shownBundles(on: { _ in true }, custom: store.customBundles), size: 44)
            VStack(alignment: .leading, spacing: 4) {
                Text(verbatim: t.summary.subject.isEmpty ? "(no subject)" : t.summary.subject)
                    .font(.title3.weight(.semibold))
                    .textSelection(.enabled)
                // The real address, always: a display name can say anything. A thread shows each message's below.
                if t.members.count == 1, let m = t.members.first {
                    Text(verbatim: "\(Mail.personLabel(m.from)) <\(m.from.address)>").font(.subheadline).textSelection(.enabled)
                    Text(verbatim: ISO.date(m.at)?.shortDateTime ?? "").font(.caption).foregroundStyle(.secondary)
                } else {
                    Text(verbatim: t.people).font(.subheadline).foregroundStyle(.secondary)
                }
            }
        }
    }

    private func actions(_ t: MailThread) -> some View {
        let back = t.state == .done
        // Where the mail is kept, by its own mailbox: "in Gmail", "in iCloud", or "in your mailbox" (it said iCloud for every one).
        let where_ = Mail.inProvider(Mail.mailboxOf(store.list?.mailboxes ?? [], t.summary.mailbox))
        let readOnly = store.readOnly(t)
        return FlowLayout(spacing: 8) {
            // A Read only mailbox (Settings, Accounts) takes no Done and no Pin.
            if !readOnly {
                Button { Task { await store.done([t], inDone: back); leave() } } label: {
                    Label(back ? "Move to Inbox" : "Done", systemImage: back ? "tray" : "checkmark")
                }
                .help(back ? "Move back to the Inbox \(where_)" : "Done: moves it to Archive \(where_)")
            }
            if !back {
                Button { snooze(t) } label: { Label(t.state == .snoozed ? "Change snooze" : "Snooze", systemImage: "clock") }
                    .help(t.state == .snoozed ? "Change when it comes back" : "Snooze: hide it until a time you pick")
            }
            if t.state == .snoozed {
                Button { Task { await store.unsnooze(t) } } label: { Label("Unsnooze", systemImage: "tray") }
            }
            if !readOnly {
                Button { Task { await store.pin([t]) } } label: { Label(t.pinned ? "Unpin" : "Pin", systemImage: t.pinned ? "pin.slash" : "pin") }
            }
            Button { Task { await store.read([t], false); leave() } } label: { Label("Mark unread", systemImage: "envelope.badge") }
                .help("Mark unread, here and in your mail app")
            #if os(macOS)
            MailMoveButtons(store: store, threads: [t]) { leave() }
            if let a = answer(t) {
                Button { tools = a } label: { Label("Unsubscribe or block", systemImage: "hand.raised") }
                    .help("Unsubscribe from this sender's mail, or block them")
                if let showPerson {
                    Button { showPerson(a.from) } label: { Label("All with \(firstName(a.from))", systemImage: "person") }
                        .help("All your mail with \(a.from.address)")
                }
            }
            #else
            // On the iPhone and iPad the rest is in More, so the bar stays a line or two.
            MailMoveButtons(store: store, threads: [t], spam: false, move: false) { leave() }
            Menu {
                MailMoveButtons(store: store, threads: [t], delete: false) { leave() }
                if let a = answer(t) {
                    Button { tools = a } label: { Label("Unsubscribe or block", systemImage: "hand.raised") }
                    if let showPerson {
                        Button { showPerson(a.from) } label: { Label("All with \(firstName(a.from))", systemImage: "person") }
                    }
                }
            } label: { Label("More", systemImage: "ellipsis.circle") }
            .fixedSize()
            #endif
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
    }

    /// The thread's newest mail from someone else (never the owner's own reply): the sender Unsubscribe and Block are for.
    private func answer(_ t: MailThread) -> MailSummary? { t.members.last { !$0.isMine } }

    private func firstName(_ a: MailAddress) -> String { Mail.personLabel(a).split(whereSeparator: { $0.isWhitespace }).first.map(String.init) ?? a.address }

    private func leave() {
        closed()
        #if os(iOS)
        dismiss()
        #endif
    }
}

/// One message of a thread: a line (who, when, first words) that opens to the whole message.
struct MailThreadMessage: View {
    @ObservedObject var store: MailStore
    var mail: MailSummary
    /// The thread's only mail: shown whole, with no line of its own.
    var single = false
    var startOpen: Bool
    @State private var open: Bool?

    var body: some View {
        // Open from the start when a reply or a forward is being written under it.
        let isOpen = single || (open ?? (startOpen || MailWriting.shared.open[mail.id] != nil))
        VStack(alignment: .leading, spacing: 8) {
            if !single { head(isOpen) }
            if isOpen {
                MailMessageBody(store: store, mail: mail)
                MailWriteButtons(store: store, mail: mail)
            }
        }
    }

    private func head(_ isOpen: Bool) -> some View {
        Button { open = !isOpen } label: {
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(verbatim: mail.isMine ? "You" : Mail.personLabel(mail.from)).fontWeight(.semibold)
                    Text(verbatim: "<\(mail.from.address)>").foregroundStyle(.secondary).lineLimit(1)
                    Spacer(minLength: 6)
                    Text(verbatim: ISO.date(mail.at)?.shortDateTime ?? "").font(.caption).foregroundStyle(.secondary)
                }
                .font(.subheadline)
                if !isOpen { Text(verbatim: mail.preview).font(.subheadline).foregroundStyle(.secondary).lineLimit(1) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint(isOpen ? "Hides this message" : "Shows this message")
    }
}

/// One message's body: the mail as sent (the hub's cleaned page), or its text; fetched from the hub when it shows.
struct MailMessageBody: View {
    @ObservedObject var store: MailStore
    var mail: MailSummary
    @State private var full: MailMessage?
    @State private var error: String?
    @State private var asText = false
    /// The quoted history under a reply: folded until the button is pressed (its page marks it, or its text's quote line).
    @State private var showQuote = false
    @State private var pageQuote = false
    @State private var fetchingPictures = false
    /// "Folded too much?": the note on what the fold hid.
    @State private var noting = false
    @State private var picturesError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if Mail.nameHidesAddress(mail.from) {
                Text("The sender's name shows a different address than the one it came from.")
                    .font(.footnote).foregroundStyle(.warnText)
            }
            if let cards = mail.cards, !cards.isEmpty { MailFactsView(cards: cards) }
            if mail.asksForAttachments { MailAttachmentsView(store: store, mail: mail) }
            if let full, let html = full.html, !asText {
                if full.pictures_ask { picturesLine }
                MailPageView(html: html, unfolded: showQuote, foldable: $pageQuote)
                    .id(html.hashValue)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
            } else if let full {
                MailLinkedText(text: full.quote_at != nil && !showQuote ? full.ownText : full.text)
            } else if let error {
                Text(verbatim: error).foregroundStyle(.dangerText)
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
            if let full, hasQuote(full) {
                HStack(spacing: 10) {
                    Button { showQuote.toggle() } label: { Text(verbatim: "\u{2022}\u{2022}\u{2022}").fontWeight(.bold) }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .accessibilityLabel(showQuote ? "Hide the quoted text" : "Show the quoted text")
                        .help(showQuote ? "Hide the quoted text" : "Show the quoted text")
                    // A folder's mail has no note: notes are for Inbox mail.
                    if mail.state != .folder {
                        Button("Folded too much?") { noting = true }.buttonStyle(.borderless).font(.footnote)
                    }
                }
            }
            if let full { footer(full) }
        }
        .task(id: mail.id) {
            do {
                full = try await store.message(mail.id)
                if full?.no_fold == true { showQuote = true }
            } catch { self.error = error.localizedDescription }
        }
        .sheet(isPresented: $noting) {
            if let full {
                MailFoldNoteSheet(store: store, mail: mail, lines: Mail.foldedLines(full.text, quoteAt: full.quote_at)) { unfold in
                    if unfold { showQuote = true; self.full?.quote_at = nil; self.full?.no_fold = true }
                }
            }
        }
    }

    private func hasQuote(_ m: MailMessage) -> Bool { m.html != nil && !asText ? pageQuote : m.quote_at != nil }

    /// Show pictures (a hub without Tor): the hub fetches this mail's pictures from its sender now.
    private var picturesLine: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button(fetchingPictures ? "Fetching pictures" : "Show pictures") {
                fetchingPictures = true
                picturesError = nil
                Task {
                    do { full = try await store.showPictures(mail.id) } catch { picturesError = error.localizedDescription }
                    fetchingPictures = false
                }
            }
            .disabled(fetchingPictures)
            .buttonStyle(.bordered)
            Text("This mail's pictures are not loaded. Your hub would fetch them from the sender, who then sees your home's internet address. A hub with Tor loads pictures on its own, without showing it.")
                .font(.footnote).foregroundStyle(.secondary)
            if let picturesError { Text(verbatim: picturesError).font(.footnote).foregroundStyle(.dangerText) }
        }
    }

    private func footer(_ m: MailMessage) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            if m.html != nil {
                Text(asText ? "Shown as text." : m.pictures_pending ? "The hub is still fetching this mail's pictures." : m.pictures_ask ? "Shown as sent, without its pictures." : "Shown as sent. Pictures were fetched by the hub, not this device.")
                Button(asText ? "Show as sent" : "Show as text") { asText.toggle() }
                    .buttonStyle(.borderless)
            } else {
                Text("Shown as text: this mail has no other version.")
            }
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
    }
}
