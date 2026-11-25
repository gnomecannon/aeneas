import SwiftUI
import UniformTypeIdentifiers
import EACore
#if os(iOS)
import PhotosUI
#endif

/// What is being written on the Mail screen, kept here and not in a writing box, as on the web (`WRITING` in
/// web/src/views/Mail.tsx): which box is open under each mail (by the mail's id; a new mail under `Mail.newMailKey`),
/// and what each box holds (`Mail.writingKey`). A box that closes and opens again (Reply all after Reply, a thread
/// closed and opened, the list changed under it, New mail pressed twice) shows what was typed; only Save draft, Send,
/// Discard, and moving the mail it was written on (after a question) let it go. In memory only, while the app runs:
/// nothing written is kept on the device.
///
/// No screen watches this keeping as a whole. Each box's words are an object of their own (`Typed`), watched only by
/// the box that shows them, so a letter typed redraws that box and nothing else. (When the words were one published
/// list here, the Mail screen and every open thread watched it, and each letter worked out the whole list again: with
/// a real mailbox, seconds a letter on an iPhone.) Which boxes are open is read when a screen is made, and each screen
/// keeps its own copy, so a box opening or closing redraws only the screen it is on.
@MainActor
final class MailWriting {
    static let shared = MailWriting()

    /// The writing box open under a mail: a reply to the sender or to all, or a forward (a changed draft: `draft`).
    enum Box: String { case one, all, forward, draft, new }

    /// One box's words, published to the box that shows them only. Nil: nothing kept (never opened, or let go).
    final class Typed: ObservableObject {
        @Published var w: Mail.Writing?
    }

    var open: [String: Box] = [:]
    private var boxes: [String: Typed] = [:]

    /// The key of the box whose mail is in the outbox under this id, if one holds it.
    func key(holding outbox: String) -> String? { boxes.first { $0.value.w?.outbox == outbox }?.key }

    /// The words of the box with this key (`Mail.writingKey`), made empty the first time.
    func box(_ key: String) -> Typed {
        if let b = boxes[key] { return b }
        let b = Typed()
        boxes[key] = b
        return b
    }

    /// Whether words written to a mail (a reply, a forward, a changed draft) are not saved yet.
    func hasUnsaved(_ id: String) -> Bool { ["reply", "forward", "draft"].contains { boxes["\($0):\(id)"]?.w?.dirty == true } }

    /// A mail that moved away takes what was written to it along.
    func forget(_ id: String) {
        for k in ["reply", "forward", "draft"] { boxes["\(k):\(id)"]?.w = nil }
        open[id] = nil
    }

    /// A mail the assistant wrote, opened by its card's Edit (since 2026-11-24): New mail's box filled with it, to send
    /// or save as a draft from there, and the Mail screen told to open the box.
    func openNewMail(_ w: Mail.Writing) {
        box(Mail.newMailKey).w = w
        open[Mail.newMailKey] = .new
        NotificationCenter.default.post(name: .mailOpenNewMail, object: nil)
    }

    /// The mailbox a new mail went from last time, remembered on this device (an address of the owner's, no mail).
    static var lastFrom: String? {
        get { UserDefaults.standard.string(forKey: "MailNewMailFrom") }
        set { UserDefaults.standard.set(newValue, forKey: "MailNewMailFrom") }
    }
}

extension Notification.Name {
    /// New mail's box was filled from elsewhere (a mail the assistant wrote, Edit): the Mail screen opens it.
    static let mailOpenNewMail = Notification.Name("ea.mail.openNewMail")
}

/// What a writing box writes: a reply (to the sender, or `all`) or a forward of a mail (`mailbox`: the one it is in,
/// when the mail does not say), a kept draft changed (in the mailbox `email`), or a new mail.
enum MailComposeTarget {
    case reply(MailSummary, all: Bool)
    case forward(MailSummary, mailbox: String?)
    case draft(MailFolderMail, email: String)
    case fresh

    var what: Mail.DraftFor {
        switch self {
        case .reply(let m, let all): return .reply(m.id, all: all)
        case .forward(let m, _): return .forward(m.id)
        case .draft(let d, let email): return .draft(d.id, from: email)
        case .fresh: return .fresh
        }
    }
    /// The mail the box is under (none for a new mail).
    var under: MailSummary? {
        switch self {
        case .reply(let m, _), .forward(let m, _): return m
        case .draft(let d, _): return d.summary
        case .fresh: return nil
        }
    }
}

/// Said in the writing box of a draft that was written with formatting, before it is saved from here.
private let formattedDraft = "This draft has formatting from another mail app. Saving it here keeps its words only. The old version goes to Trash."

/// Writing mail (as the web's Composer): a reply to an open mail (the hub sets its recipient, the sender's From, its
/// subject and its thread), a reply to all, a forward, a new mail, or a kept draft changed. Write, then Preview: the
/// hub answers with the whole mail, shown here as text. Then Send (since 2026-11-24, for a mailbox with a sending
/// server that is not Read only): the mail goes into the hub's outbox, the box says Sending with Undo for 10 seconds,
/// and Undo puts it back here as it was; a mail the server refuses comes back with the hub's words, Try again, Save
/// draft and Edit. Or Save draft: to the mailbox's Drafts folder.
struct MailComposer: View {
    @ObservedObject var store: MailStore
    /// This box's words, and nothing else of the keeping: a letter typed redraws this box only.
    @ObservedObject private var typed: MailWriting.Typed
    var target: MailComposeTarget
    /// False: the box was open before the screen showed, and does not take the focus.
    var takesFocus = true
    var close: () -> Void

    init(store: MailStore, target: MailComposeTarget, takesFocus: Bool = true, close: @escaping () -> Void) {
        self.store = store
        self.target = target
        self.takesFocus = takesFocus
        self.close = close
        _typed = ObservedObject(wrappedValue: MailWriting.shared.box(Mail.writingKey(target.what)))
    }

    @State private var preview: MailDraft?
    @State private var saved = false
    @State private var busy = false
    @State private var err: String?
    @State private var suggesting = false
    @State private var loadErr: String?
    @State private var loadTry = 0
    @State private var picking = false
    @State private var askDiscard = false
    /// The mail in the hub's outbox once sent, as last asked (`itemKnown`: asked at least once), and Sent.
    @State private var item: MailOutboxItem?
    @State private var itemKnown = false
    @State private var sentDone = false
    @State private var looks = 0
    #if os(iOS)
    @State private var photos: [PhotosPickerItem] = []
    @State private var pickingPhotos = false
    #endif
    @FocusState private var textFocused: Bool

    private var key: String { Mail.writingKey(target.what) }
    /// The mailboxes a draft can be saved to: never a Read only one (Settings, Accounts).
    private var boxes: [MailMailbox] { Mail.writableBoxes(store.boxes) }
    /// A new mail goes from one of several mailboxes: the one used last time, until another is chosen.
    private var choosesFrom: Bool { if case .fresh = target { return boxes.count > 1 } else { return false } }
    /// A new mail says which mailbox it goes from whenever several are linked, so one that is Read only is never the
    /// hub's first choice for it.
    private var sendsFrom: Bool { if case .fresh = target { return store.boxes.count > 1 && !boxes.isEmpty } else { return false } }

    /// What the box starts with the first time it opens.
    private var start: Mail.Writing {
        var w = Mail.Writing()
        w.from = Mail.fromChoice(boxes, last: MailWriting.lastFrom)
        switch target {
        case .draft(let d, _):
            w.to = d.to.map(\.address).joined(separator: ", ")
            w.subject = d.summary.subject
            w.ready = false
            w.kept = nil
        case .forward(let m, _):
            w.withTheirs = m.asksForAttachments
        default: break
        }
        return w
    }
    private var t: Mail.Writing { typed.w ?? start }

    /// Change what the box holds, in the screen's keeping. `typing` false: no words were typed and no file attached by
    /// it (the hub's suggestion, a draft's own words, a choice or a removal), so Discard has nothing to ask about.
    private func set(typing: Bool = true, _ change: (inout Mail.Writing) -> Void) {
        #if DEBUG
        if typing { MailProbe.letter() }
        #endif
        var w = t
        change(&w)
        if typing { w.dirty = true }
        typed.w = w
    }

    private func field(_ k: WritableKeyPath<Mail.Writing, String>) -> Binding<String> {
        Binding(get: { t[keyPath: k] }, set: { v in set { $0[keyPath: k] = v } })
    }

    private var from: String { Mail.fromChoice(boxes, last: t.from) }
    /// The mailbox the mail it answers or forwards is in, the draft's, or the one a new mail goes from.
    private var box: MailMailbox? {
        switch target {
        case .reply(let m, _): return Mail.mailboxOf(store.boxes, m.mailbox)
        case .forward(let m, let mb): return Mail.mailboxOf(store.boxes, mb ?? m.mailbox)
        case .draft(_, let email): return Mail.mailboxOf(store.boxes, email)
        case .fresh: return Mail.mailboxOf(boxes, choosesFrom ? from : nil)
        }
    }
    private var app: String { Mail.mailApp(box) }
    /// Send is offered: the mailbox has a sending server and is not Read only.
    private var sends: Bool { Mail.canSend(box) }
    private var outboxId: String? { t.outbox }
    private var isReply: Bool { if case .reply = target { return true } else { return false } }
    private var isForward: Bool { if case .forward = target { return true } else { return false } }
    private var isDraft: Bool { if case .draft = target { return true } else { return false } }
    private var toAll: Bool { if case .reply(_, let all) = target { return all } else { return false } }

    var body: some View {
        #if DEBUG
        let _ = MailProbe.count("MailComposer")
        #endif
        Group {
            if sentDone {
                VStack(alignment: .leading, spacing: 8) {
                    Text(Mail.SendTexts.sent)
                    Button("Close") { close() }.buttonStyle(.bordered)
                }
            } else if let id = outboxId, !(itemKnown && item == nil) {
                outboxFace(id)
            } else if saved {
                VStack(alignment: .leading, spacing: 8) {
                    Text(verbatim: sends ? "Saved to Drafts \(Mail.inProvider(box))." : "Saved to Drafts \(Mail.inProvider(box)). Open Drafts in \(app) to send it.")
                    Button("Close") { if isDraft { Task { await store.load() } }; close() }
                        .buttonStyle(.bordered)
                }
            } else if let p = preview {
                previewFace(p)
            } else {
                writingFace
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.secondary.opacity(0.08)))
        .onAppear { if typed.w == nil { typed.w = start } }
        // A reply's greeting and sign-off, and up to 3 short replies: suggested by the hub when the reply first opens,
        // each the owner's to edit or drop. What the owner already changed is never overwritten.
        .task(id: key) {
            guard case .reply(let m, _) = target, !t.suggested else { return }
            suggesting = true
            if let g = try? await store.greeting(m.id) {
                set(typing: false) {
                    if !$0.touchedGreeting { $0.greeting = g.greeting }
                    if !$0.touchedSignoff { $0.signoff = g.signoff }
                    $0.smart = g.replies
                    $0.suggested = true
                }
            }
            suggesting = false
        }
        // A kept draft changed: its words and its attachments are read first. Nothing can be previewed or saved before
        // both are here: a save from half of it would drop the rest, since the old draft goes to Trash.
        .task(id: "\(key):\(loadTry)") {
            guard case .draft(let d, _) = target, !t.ready else { return }
            loadErr = nil
            do {
                let m = try await store.message(d.id)
                let kept = d.summary.asksForAttachments ? try await store.attachments(d.id) : []
                set(typing: false) {
                    $0.text = m.text
                    $0.html = m.html != nil
                    $0.kept = kept.map { MailAttachment(part: $0.part, name: $0.name, type: $0.type, size: $0.size) }
                    $0.ready = true
                }
                if takesFocus { textFocused = true }
            } catch { loadErr = error.localizedDescription }
        }
        // A preview is of the mail as it was asked for: Reply all pressed after Reply (or Reply after Reply all) is no
        // longer what would be saved, so the box goes back to the text, to be previewed again.
        .onChange(of: toAll) { _, _ in preview = nil }
        .fileImporter(isPresented: $picking, allowedContentTypes: [.item], allowsMultipleSelection: true) { r in
            if case .success(let urls) = r { addFiles(urls) }
        }
        #if os(iOS)
        .photosPicker(isPresented: $pickingPhotos, selection: $photos, matching: .images)
        .onChange(of: photos) { _, items in
            guard !items.isEmpty else { return }
            photos = []
            Task { await addPhotos(items) }
        }
        #endif
        .confirmationDialog("Discard what you wrote? It is not saved to Drafts.", isPresented: $askDiscard, titleVisibility: .visible) {
            Button("Discard", role: .destructive) { forgetAndClose() }
        }
        // A mail sent: asked every second while it waits or is on its way, until it is sent or was not.
        .task(id: "\(outboxId ?? ""):\(looks)") { await watchOutbox() }
        #if DEBUG
        // -EAMailType <n>: n letters typed by themselves, as a keyboard would (MailProbe).
        .task {
            let n = UserDefaults.standard.integer(forKey: "EAMailType")
            guard n > 0 else { return }
            try? await Task.sleep(for: .seconds(3))
            for i in 0..<n where !Task.isCancelled {
                set { $0.text += i % 6 == 5 ? " " : "a" }
                try? await Task.sleep(for: .milliseconds(300))
            }
            // -EAMailSendFlow YES: then Preview, and Send two seconds later (screenshots of each face).
            guard UserDefaults.standard.bool(forKey: "EAMailSendFlow"), !Task.isCancelled else { return }
            if case .fresh = target { set { $0.to = "alex@example.com"; $0.subject = "Plans for Saturday" } }
            await ask(preview: true)
            try? await Task.sleep(for: .seconds(3))
            if !Task.isCancelled { await send() }
        }
        #endif
    }

    // MARK: Writing

    private var head: AttributedString {
        func bold(_ s: String) -> AttributedString { var a = AttributedString(s); a.inlinePresentationIntent = .stronglyEmphasized; return a }
        switch target {
        case .reply(let m, let all):
            return AttributedString(all ? "Reply all to " : "Reply to ") + bold(Mail.personLabel(m.from)) + AttributedString(" <\(m.from.address)>" + (all ? " and the others on it" : ""))
        case .forward(let m, _): return AttributedString("Forward ") + bold(m.subject.isEmpty ? "(no subject)" : m.subject)
        case .draft: return bold("Edit the draft")
        case .fresh: return bold("New mail")
        }
    }

    @ViewBuilder private var writingFace: some View {
        // The fields read the box's words as they are now (`t`), never this copy: letters typed faster than the box
        // is drawn again would otherwise be written over by the copy.
        let w = t
        VStack(alignment: .leading, spacing: 10) {
            Text(head)
            // Which mail this answers: its sender, its time, and its first lines.
            if let m = isReply || isForward ? target.under : nil {
                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: "\(isReply ? "Replying to" : "Forwarding") \(Mail.personLabel(m.from)) \u{00B7} \(ISO.date(m.at)?.shortDateTime ?? "")")
                        .font(.footnote).foregroundStyle(.secondary)
                    if !m.preview.isEmpty {
                        Text(verbatim: m.preview).font(.footnote).foregroundStyle(.secondary).lineLimit(3)
                            .padding(.leading, 8)
                            .overlay(alignment: .leading) { Rectangle().fill(Color.secondary.opacity(0.4)).frame(width: 2) }
                    }
                }
            }
            // The sender asked for replies to go elsewhere: say so, since the reply goes to the address it came from.
            if case .reply(let m, _) = target, let r = m.reply_to, r.lowercased() != m.from.address.lowercased() {
                Text(verbatim: "This mail asks for replies to go to \(r). Your reply goes to the address it came from, \(m.from.address).")
                    .font(.footnote).foregroundStyle(.warnText)
            }
            if choosesFrom {
                Picker("From", selection: Binding(get: { from }, set: { v in set(typing: false) { $0.from = v } })) {
                    ForEach(boxes, id: \.email) { b in Text(verbatim: b.email).tag(b.email) }
                }
                .fixedSize()
            }
            if !isReply {
                TextField("To", text: field(\.to), prompt: Text(verbatim: "To: alex@example.com"))
                    .autocorrectionDisabled()
                    #if os(iOS)
                    .textContentType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.emailAddress)
                    #endif
                    .accessibilityLabel("To")
                // A new mail's Cc: shown while it holds something (a mail the assistant wrote, opened with Edit).
                if case .fresh = target, !w.cc.trimmingCharacters(in: .whitespaces).isEmpty {
                    HStack(spacing: 6) {
                        Text("Cc").foregroundStyle(.secondary)
                        TextField("Cc", text: field(\.cc), prompt: Text(verbatim: "Cc"))
                            .autocorrectionDisabled()
                            #if os(iOS)
                            .textInputAutocapitalization(.never)
                            .keyboardType(.emailAddress)
                            #endif
                            .accessibilityLabel("Cc")
                    }
                }
                if !isForward {
                    TextField("Subject", text: Binding(get: { t.subject }, set: { v in set { $0.subject = String(v.prefix(200)) } }), prompt: Text("Subject"))
                        .accessibilityLabel("Subject")
                }
            }
            if case .forward(let m, _) = target {
                Text("The mail goes below your words.").font(.footnote).foregroundStyle(.secondary)
                if m.asksForAttachments {
                    Toggle(m.attachments.map { "Include its attachments (\($0))" } ?? "Include its attachments",
                           isOn: Binding(get: { w.withTheirs }, set: { v in set(typing: false) { $0.withTheirs = v } }))
                        .font(.footnote)
                }
            }
            if isDraft && !w.ready {
                if let loadErr {
                    HStack {
                        Text(verbatim: loadErr).font(.footnote).foregroundStyle(.dangerText)
                        Button("Try again") { loadTry += 1 }.buttonStyle(.bordered).controlSize(.small)
                    }
                } else {
                    Text("Reading the draft").font(.footnote).foregroundStyle(.secondary)
                }
            }
            if isDraft && w.ready {
                Text(w.html ? formattedDraft : sends ? "Sending it, or saving this version to Drafts, moves the old one to Trash." : "Saving puts this version in Drafts and moves the old one to Trash.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if isReply && !w.smart.isEmpty {
                FlowLayout(spacing: 6) {
                    ForEach(w.smart, id: \.self) { r in
                        Button { set { $0.text = $0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? r : "\($0.text.replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression))\n\(r)" } } label: {
                            Text(verbatim: r).font(.footnote).padding(.horizontal, 10).padding(.vertical, 5)
                                .background(Capsule().strokeBorder(Color.secondary.opacity(0.5)))
                        }
                        .buttonStyle(.plain)
                    }
                }
                .accessibilityElement(children: .contain)
                .accessibilityLabel("Suggested replies")
            }
            if isReply { aroundLine("Greeting", value: w.greeting, lines: 1, touched: \.touchedGreeting, keyPath: \.greeting) }
            TextEditor(text: Binding(get: { t.text }, set: { v in set { $0.text = String(v.prefix(50_000)) } }))
                .focused($textFocused)
                .font(.body)
                .frame(minHeight: 140)
                .scrollContentBackground(.hidden)
                .padding(6)
                .background(RoundedRectangle(cornerRadius: 8).fill(Color.secondary.opacity(0.08)))
                .overlay(alignment: .topLeading) {
                    if w.text.isEmpty {
                        Text(isReply ? "Write your reply: just what you want to say" : isForward ? "Add a note (optional)" : "Write your mail")
                            .foregroundStyle(.secondary).padding(.horizontal, 11).padding(.vertical, 14).allowsHitTesting(false)
                    }
                }
                .disabled(!w.ready)
                .accessibilityLabel("Your mail")
            filesList(w)
            if isReply { aroundLine("Sign-off", value: w.signoff, lines: 2, touched: \.touchedSignoff, keyPath: \.signoff) }
            FlowLayout(spacing: 10) {
                Button(busy ? "Checking" : "Preview") { Task { await ask(preview: true) } }
                    .buttonStyle(.borderedProminent)
                    .disabled(busy || !w.ready || (!isForward && w.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) || (!isReply && w.to.trimmingCharacters(in: .whitespaces).isEmpty))
                Button("Discard") { discard() }.buttonStyle(.borderless)
                attachButton
            }
            Text(verbatim: Mail.writeNote(box)).font(.footnote).foregroundStyle(.secondary)
            if let err { Text(verbatim: err).font(.footnote).foregroundStyle(.dangerText) }
        }
        .onAppear { if takesFocus && w.ready { textFocused = true } }
    }

    /// A reply's greeting or sign-off: a short field (the hub takes at most 2 lines of plain words), with Remove; once
    /// removed, Add brings back an empty one.
    @ViewBuilder private func aroundLine(_ label: String, value: String?, lines: Int, touched: WritableKeyPath<Mail.Writing, Bool>, keyPath: WritableKeyPath<Mail.Writing, String?>) -> some View {
        if value != nil {
            HStack(alignment: .firstTextBaseline) {
                TextField(label, text: Binding(get: { t[keyPath: keyPath] ?? "" }, set: { x in set(typing: !x.isEmpty) { $0[keyPath: keyPath] = String(x.prefix(130)); $0[keyPath: touched] = true } }),
                          prompt: Text(suggesting ? "Suggesting\u{2026}" : label), axis: .vertical)
                    .lineLimit(1...lines)
                    .accessibilityLabel(label)
                Button("Remove") { set(typing: false) { $0[keyPath: keyPath] = nil; $0[keyPath: touched] = true } }
                    .buttonStyle(.borderless).font(.footnote)
                    .accessibilityLabel("Remove the \(label.lowercased())")
            }
        } else {
            Button("Add a \(label.lowercased())") { set(typing: false) { $0[keyPath: keyPath] = ""; $0[keyPath: touched] = true } }
                .buttonStyle(.borderless).font(.footnote)
        }
    }

    @ViewBuilder private var attachButton: some View {
        #if os(iOS)
        Menu {
            Button { pickingPhotos = true } label: { Label("Photos", systemImage: "photo") }
            Button { picking = true } label: { Label("Files", systemImage: "folder") }
        } label: { Label("Attach", systemImage: "paperclip") }
        .help("Attach files (at most 10, 15 MB in all)")
        #else
        Button { picking = true } label: { Label("Attach", systemImage: "paperclip") }
            .buttonStyle(.borderless)
            .help("Attach files (at most 10, 15 MB in all)")
        #endif
    }

    /// Files: a changed draft's own that stay on it (`kept`), and those the owner attaches; together at most 10 files
    /// and 15 MB, the hub's limits. A long name is shortened by the system with an ellipsis, never cut here.
    @ViewBuilder private func filesList(_ w: Mail.Writing) -> some View {
        let kept = w.kept ?? []
        if !kept.isEmpty || !w.files.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(kept) { a in
                    fileRow(a.name, "\(Mail.fileSize(a.size)), kept from the draft") { set(typing: false) { $0.kept = ($0.kept ?? []).filter { $0.part != a.part } } }
                }
                ForEach(w.files) { f in
                    fileRow(f.name, Mail.fileSize(f.size)) { set(typing: false) { $0.files.removeAll { $0.id == f.id } } }
                }
                Text("\(Mail.fileSize(w.filesBytes)) of 15 MB").font(.footnote).foregroundStyle(.secondary)
            }
        }
    }

    private func fileRow(_ name: String, _ note: String, remove: @escaping () -> Void) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "paperclip").foregroundStyle(.secondary).accessibilityHidden(true)
            Text(verbatim: name).lineLimit(1).truncationMode(.middle)
            Text(verbatim: note).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
            Spacer(minLength: 4)
            Button("Remove", action: remove).buttonStyle(.borderless).font(.footnote)
        }
    }

    private func addFiles(_ urls: [URL]) {
        var picked: [MailDraftFile] = []
        let room = max(0, Mail.draftFilesMax - (t.kept ?? []).count - t.files.count)
        var bytes = t.filesBytes
        for u in urls.prefix(room) {
            let scoped = u.startAccessingSecurityScopedResource()
            defer { if scoped { u.stopAccessingSecurityScopedResource() } }
            // The size first: a file over the limit is never read in.
            let size = (try? u.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            bytes += size
            if bytes > Mail.draftFilesBytes { err = Mail.tooBig(box); return }
            guard let data = try? Data(contentsOf: u) else { err = "\(u.lastPathComponent) could not be read."; return }
            picked.append(MailDraftFile(name: u.lastPathComponent, type: UTType(filenameExtension: u.pathExtension)?.preferredMIMEType ?? "application/octet-stream", data: data))
        }
        err = nil
        set { $0.files += picked }
        textFocused = true
    }

    #if os(iOS)
    /// Pictures from Photos, as files: each named for its kind ("Photo 1.jpeg"), within the same limits.
    private func addPhotos(_ items: [PhotosPickerItem]) async {
        var picked: [MailDraftFile] = []
        let room = max(0, Mail.draftFilesMax - (t.kept ?? []).count - t.files.count)
        var bytes = t.filesBytes
        for (i, item) in items.prefix(room).enumerated() {
            guard let data = try? await item.loadTransferable(type: Data.self) else { err = "A photo could not be read."; return }
            bytes += data.count
            if bytes > Mail.draftFilesBytes { err = Mail.tooBig(box); return }
            let type = item.supportedContentTypes.first
            let ext = type?.preferredFilenameExtension ?? "jpeg"
            picked.append(MailDraftFile(name: "Photo \(t.files.count + i + 1).\(ext)", type: type?.preferredMIMEType ?? "image/jpeg", data: data))
        }
        err = nil
        set { $0.files += picked }
    }
    #endif

    // MARK: Preview and save

    private func previewFace(_ p: MailDraft) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(verbatim: Mail.previewNote(box)).font(.footnote).foregroundStyle(.secondary)
            Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 4) {
                headRow("From", p.from.name.isEmpty ? p.from.address : "\(p.from.name) <\(p.from.address)>")
                headRow("To", p.to.joined(separator: ", "))
                if !p.cc.isEmpty { headRow("Cc", p.cc.joined(separator: ", ")) }
                if !p.bcc.isEmpty { headRow("Bcc", p.bcc.joined(separator: ", ")) }
                if !p.files.isEmpty { headRow("Files", p.files.map { "\($0.name) (\(Mail.fileSize($0.size)))" }.joined(separator: ", ")) }
                if isForward && t.withTheirs { headRow("Also", "The mail's own attachments, added from your mailbox when it is saved") }
                headRow("Subject", p.subject.isEmpty ? "(no subject)" : p.subject)
            }
            .font(.subheadline)
            Text(verbatim: p.text)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
                .background(RoundedRectangle(cornerRadius: 8).fill(Color.secondary.opacity(0.08)))
            if isDraft && t.html { Text(formattedDraft).font(.footnote).foregroundStyle(.secondary) }
            FlowLayout(spacing: 10) {
                if sends {
                    Button(busy ? "Sending" : "Send") { Task { await send() } }
                        .buttonStyle(.borderedProminent)
                        .disabled(busy)
                    Button("Save draft") { Task { await ask(preview: false) } }
                        .buttonStyle(.bordered)
                        .disabled(busy)
                } else {
                    Button(busy ? "Saving" : "Save draft") { Task { await ask(preview: false) } }
                        .buttonStyle(.borderedProminent)
                        .disabled(busy)
                }
                Button("Edit") { preview = nil; textFocused = true }.buttonStyle(.bordered).disabled(busy)
                Button("Discard") { discard() }.buttonStyle(.borderless)
            }
            if let err { Text(verbatim: err).font(.footnote).foregroundStyle(.dangerText) }
        }
    }

    private func headRow(_ label: String, _ value: String) -> some View {
        GridRow {
            Text(label).foregroundStyle(.secondary).gridColumnAlignment(.trailing)
            Text(verbatim: value).textSelection(.enabled)
        }
    }

    private func ask(preview asPreview: Bool) async {
        busy = true
        err = nil
        defer { busy = false }
        let w = t
        let files = w.files.map { MailDraftFileIn(name: $0.name, type: $0.type, data: $0.data.base64EncodedString()) }
        do {
            let r = try await store.draft(Mail.draftRequest(target.what, w, files: files, preview: asPreview, from: sendsFrom ? from : nil))
            if asPreview {
                preview = r
            } else {
                // Saved: nothing is left to keep, and the box does not open again by itself.
                typed.w = nil
                MailWriting.shared.open[target.under?.id ?? Mail.newMailKey] = nil
                if choosesFrom { MailWriting.lastFrom = from }
                saved = true
                // The new draft is in Drafts now: the list again, for the side list's count. (A changed draft's old row
                // is the one this box is under, so its list is loaded when the box closes.)
                if !isDraft { await store.load() }
            }
        } catch { err = error.localizedDescription }
    }

    // MARK: Sending

    /// Send: the mail into the hub's outbox; the box then shows it Sending, with Undo.
    private func send() async {
        busy = true
        err = nil
        defer { busy = false }
        let w = t
        let files = w.files.map { MailDraftFileIn(name: $0.name, type: $0.type, data: $0.data.base64EncodedString()) }
        do {
            let r = try await store.send(Mail.draftRequest(target.what, w, files: files, preview: false, from: sendsFrom ? from : nil))
            item = r.item
            itemKnown = true
            set(typing: false) { $0.outbox = r.id }
            preview = nil
        } catch { err = error.localizedDescription }
    }

    /// While the mail waits or is on its way: asked every second. Sent: what was written goes; not there any more
    /// (taken back on another device): what was written shows again.
    private func watchOutbox() async {
        guard let id = outboxId else { item = nil; itemKnown = false; return }
        while !Task.isCancelled {
            do {
                guard let got = try await store.outboxItem(id) else {
                    item = nil
                    itemKnown = true
                    set(typing: false) { $0.outbox = nil }
                    return
                }
                item = got
                itemKnown = true
                if got.state == "sent" {
                    typed.w = nil
                    MailWriting.shared.open[target.under?.id ?? Mail.newMailKey] = nil
                    if choosesFrom { MailWriting.lastFrom = from }
                    sentDone = true
                    await store.load()
                    return
                }
                if got.state == "failed" { await store.load(); return }
            } catch {
                // Out of reach for a moment: asked again.
            }
            try? await Task.sleep(for: .seconds(1))
        }
    }

    /// Undo (while it waits) or Edit (once it was not sent): out of the outbox, back to the box as it was.
    private func takeBack() async {
        guard let id = outboxId else { return }
        busy = true
        err = nil
        defer { busy = false }
        do {
            try await store.takeBack(id)
            set(typing: false) { $0.outbox = nil }
            item = nil
            itemKnown = false
            await store.load()
        } catch {
            err = error.localizedDescription
            looks += 1
        }
    }

    private func retry() async {
        guard let id = outboxId else { return }
        busy = true
        err = nil
        defer { busy = false }
        do { item = try await store.retrySend(id); looks += 1 } catch { err = error.localizedDescription }
    }

    /// Save draft, for a mail that was not sent: the hub puts it in Drafts as it is.
    private func outboxDraft() async {
        guard let id = outboxId else { return }
        busy = true
        err = nil
        defer { busy = false }
        do {
            try await store.draftFromOutbox(id)
            typed.w = nil
            MailWriting.shared.open[target.under?.id ?? Mail.newMailKey] = nil
            saved = true
            await store.load()
        } catch { err = error.localizedDescription }
    }

    /// The box while its mail is in the outbox: Sending (with Undo while it waits), or Not sent with the hub's words.
    @ViewBuilder private func outboxFace(_ id: String) -> some View {
        switch Mail.outboxFace(item ?? MailOutboxItem(id: id)) {
        case .failed(let why):
            VStack(alignment: .leading, spacing: 8) {
                Text(Mail.SendTexts.failed).font(.headline)
                Text(verbatim: why).font(.footnote).foregroundStyle(.dangerText)
                FlowLayout(spacing: 10) {
                    Button("Try again") { Task { await retry() } }.buttonStyle(.borderedProminent).disabled(busy)
                    Button("Save draft") { Task { await outboxDraft() } }.buttonStyle(.bordered).disabled(busy)
                    Button("Edit") { Task { await takeBack() } }.buttonStyle(.bordered).disabled(busy)
                }
                if let err { Text(verbatim: err).font(.footnote).foregroundStyle(.dangerText) }
            }
            .accessibilityElement(children: .contain)
        case .sending(let undo):
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 12) {
                    ProgressView()
                    VStack(alignment: .leading, spacing: 2) {
                        Text(Mail.SendTexts.sending).font(.headline)
                        if let to = item?.to, !to.isEmpty {
                            Text(verbatim: "To \(to.joined(separator: ", "))").font(.footnote).foregroundStyle(.secondary).lineLimit(2)
                        }
                    }
                    Spacer(minLength: 8)
                    if undo {
                        Button("Undo") { Task { await takeBack() } }.buttonStyle(.borderedProminent).disabled(busy)
                    }
                }
                if let err { Text(verbatim: err).font(.footnote).foregroundStyle(.dangerText) }
            }
        case .sent, .gone:
            Text(Mail.SendTexts.sent)
        }
    }

    private func discard() {
        if t.dirty { askDiscard = true } else { forgetAndClose() }
    }

    private func forgetAndClose() {
        typed.w = nil
        close()
    }
}

/// A message's Reply, Reply all and Forward (the owner's own reply has Forward only), with the writing box right
/// below it, open again when it was open before (the thread closed and opened, the list changed under it).
/// None for mail in a Read only mailbox: a reply is a draft saved to the mailbox (as the web's Message hides them).
struct MailWriteButtons: View {
    @ObservedObject var store: MailStore
    var mail: MailSummary
    /// The mailbox the mail is in, when the mail itself does not say (a folder's mail).
    var mailbox: String? = nil
    /// The box shown: open again when it was open before. Kept here too, so a saved box stays to say where its draft
    /// went (saving lets the screen's keeping of it go) until Close.
    @State private var w: MailWriting.Box?

    init(store: MailStore, mail: MailSummary, mailbox: String? = nil) {
        self.store = store
        self.mail = mail
        self.mailbox = mailbox
        _w = State(initialValue: MailWriting.shared.open[mail.id])
    }

    private func setW(_ k: MailWriting.Box?) { MailWriting.shared.open[mail.id] = k; w = k }

    var body: some View {
        #if DEBUG
        let _ = MailProbe.count("MailWriteButtons")
        #endif
        if !store.readOnly(mailbox: mailbox ?? mail.mailbox) { buttons }
    }

    private var buttons: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                if !mail.isMine {
                    toggle(.one, "Reply", "arrowshape.turn.up.left")
                    toggle(.all, "Reply all", "arrowshape.turn.up.left.2")
                }
                toggle(.forward, "Forward", "arrowshape.turn.up.right")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            // Reply and Reply all are one writing box: what is typed stays when one is pressed after the other.
            if w == .forward {
                MailComposer(store: store, target: .forward(mail, mailbox: mailbox)) { setW(nil) }
            } else if w == .one || w == .all {
                MailComposer(store: store, target: .reply(mail, all: w == .all)) { setW(nil) }
            }
        }
    }

    private func toggle(_ k: MailWriting.Box, _ label: String, _ symbol: String) -> some View {
        let on = w == k
        return Button { setW(on ? nil : k) } label: { Label(label, systemImage: symbol) }
            .tint(on ? MailFill(key: .place("inbox")) : nil)
            .accessibilityAddTraits(on ? .isSelected : [])
    }
}
