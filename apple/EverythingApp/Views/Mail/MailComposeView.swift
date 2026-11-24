import SwiftUI
import UniformTypeIdentifiers
import EACore
#if os(iOS)
import PhotosUI
#endif

/// What is being written on the Mail screen, kept here and not in a writing box, as on the web (`WRITING` in
/// web/src/views/Mail.tsx): which box is open under each mail (by the mail's id; a new mail under `Mail.newMailKey`),
/// and what each box holds (`Mail.writingKey`). A box that closes and opens again (Reply all after Reply, a thread
/// closed and opened, the list changed under it, New mail pressed twice) shows what was typed; only Save to Drafts,
/// Discard, and moving the mail it was written on (after a question) let it go. In memory only, while the app runs:
/// nothing written is kept on the device.
@MainActor
final class MailWriting: ObservableObject {
    static let shared = MailWriting()

    /// The writing box open under a mail: a reply to the sender or to all, or a forward (a changed draft: `draft`).
    enum Box: String { case one, all, forward, draft, new }

    @Published var open: [String: Box] = [:]
    @Published var typed: [String: Mail.Writing] = [:]

    /// Whether words written to a mail (a reply, a forward, a changed draft) are not saved yet.
    func hasUnsaved(_ id: String) -> Bool { ["reply", "forward", "draft"].contains { typed["\($0):\(id)"]?.dirty == true } }

    /// A mail that moved away takes what was written to it along.
    func forget(_ id: String) {
        for k in ["reply", "forward", "draft"] { typed["\(k):\(id)"] = nil }
        open[id] = nil
    }

    /// The mailbox a new mail went from last time, remembered on this device (an address of the owner's, no mail).
    static var lastFrom: String? {
        get { UserDefaults.standard.string(forKey: "MailNewMailFrom") }
        set { UserDefaults.standard.set(newValue, forKey: "MailNewMailFrom") }
    }
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

/// Writing mail, as a draft (as the web's Composer): a reply to an open mail (the hub sets its recipient, the sender's
/// From, its subject and its thread), a reply to all, a forward, a new mail, or a kept draft changed. Write, then
/// Preview: the hub answers with the whole mail it would save, shown here as text, and only Save to Drafts saves it,
/// to the mailbox's Drafts folder. The owner sends it from their mail app: nothing is sent here.
struct MailComposer: View {
    @ObservedObject var store: MailStore
    @ObservedObject private var writing = MailWriting.shared
    var target: MailComposeTarget
    /// False: the box was open before the screen showed, and does not take the focus.
    var takesFocus = true
    var close: () -> Void

    @State private var preview: MailDraft?
    @State private var saved = false
    @State private var busy = false
    @State private var err: String?
    @State private var suggesting = false
    @State private var loadErr: String?
    @State private var loadTry = 0
    @State private var picking = false
    @State private var askDiscard = false
    #if os(iOS)
    @State private var photos: [PhotosPickerItem] = []
    @State private var pickingPhotos = false
    #endif
    @FocusState private var textFocused: Bool

    private var key: String { Mail.writingKey(target.what) }
    /// The mailboxes a draft can be saved to: never a Read only one (Settings, Connections).
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
    private var t: Mail.Writing { writing.typed[key] ?? start }

    /// Change what the box holds, in the screen's keeping. `typing` false: no words were typed and no file attached by
    /// it (the hub's suggestion, a draft's own words, a choice or a removal), so Discard has nothing to ask about.
    private func set(typing: Bool = true, _ change: (inout Mail.Writing) -> Void) {
        var w = t
        change(&w)
        if typing { w.dirty = true }
        writing.typed[key] = w
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
    private var isReply: Bool { if case .reply = target { return true } else { return false } }
    private var isForward: Bool { if case .forward = target { return true } else { return false } }
    private var isDraft: Bool { if case .draft = target { return true } else { return false } }
    private var toAll: Bool { if case .reply(_, let all) = target { return all } else { return false } }

    var body: some View {
        Group {
            if saved {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Saved to Drafts \(Mail.inProvider(box)). Open Drafts in \(app) to send it.")
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
        .onAppear { if writing.typed[key] == nil { writing.typed[key] = start } }
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
                if !isForward {
                    TextField("Subject", text: Binding(get: { w.subject }, set: { v in set { $0.subject = String(v.prefix(200)) } }), prompt: Text("Subject"))
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
                Text(w.html ? formattedDraft : "Saving puts this version in Drafts and moves the old one to Trash.")
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
            TextEditor(text: Binding(get: { w.text }, set: { v in set { $0.text = String(v.prefix(50_000)) } }))
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
            Text("Saved to Drafts \(Mail.inProvider(box)), to send from \(app).").font(.footnote).foregroundStyle(.secondary)
            if let err { Text(verbatim: err).font(.footnote).foregroundStyle(.dangerText) }
        }
        .onAppear { if takesFocus && w.ready { textFocused = true } }
    }

    /// A reply's greeting or sign-off: a short field (the hub takes at most 2 lines of plain words), with Remove; once
    /// removed, Add brings back an empty one.
    @ViewBuilder private func aroundLine(_ label: String, value: String?, lines: Int, touched: WritableKeyPath<Mail.Writing, Bool>, keyPath: WritableKeyPath<Mail.Writing, String?>) -> some View {
        if let v = value {
            HStack(alignment: .firstTextBaseline) {
                TextField(label, text: Binding(get: { v }, set: { x in set(typing: !x.isEmpty) { $0[keyPath: keyPath] = String(x.prefix(130)); $0[keyPath: touched] = true } }),
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
            Text("This is the whole mail. Save it to Drafts, then send it from \(app).").font(.footnote).foregroundStyle(.secondary)
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
                Button(busy ? "Saving" : "Save to Drafts") { Task { await ask(preview: false) } }
                    .buttonStyle(.borderedProminent)
                    .disabled(busy)
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
                writing.typed[key] = nil
                writing.open[target.under?.id ?? Mail.newMailKey] = nil
                if choosesFrom { MailWriting.lastFrom = from }
                saved = true
                // The new draft is in Drafts now: the list again, for the side list's count. (A changed draft's old row
                // is the one this box is under, so its list is loaded when the box closes.)
                if !isDraft { await store.load() }
            }
        } catch { err = error.localizedDescription }
    }

    private func discard() {
        if t.dirty { askDiscard = true } else { forgetAndClose() }
    }

    private func forgetAndClose() {
        writing.typed[key] = nil
        close()
    }
}

/// A message's Reply, Reply all and Forward (the owner's own reply has Forward only), with the writing box right
/// below it, open again when it was open before (the thread closed and opened, the list changed under it).
/// None for mail in a Read only mailbox: a reply is a draft saved to the mailbox (as the web's Message hides them).
struct MailWriteButtons: View {
    @ObservedObject var store: MailStore
    @ObservedObject private var writing = MailWriting.shared
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

    private func setW(_ k: MailWriting.Box?) { writing.open[mail.id] = k; w = k }

    var body: some View {
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
