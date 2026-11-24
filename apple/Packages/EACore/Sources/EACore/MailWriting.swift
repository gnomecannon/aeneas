import Foundation

// Writing mail on the Mail screen, as the web writes it (web/src/lib/mail.ts, CONTRACT.md Mail, POST /mail/drafts): a
// reply, a reply to all, a forward, a new mail or a kept draft changed, always as a draft in the mailbox's Drafts
// folder. Nothing is sent from the app: the owner sends it from their mail app. And an open mail's attachments, read
// from the mailbox only when the mail is opened, a file's bytes only when the owner asks for it.
//
// What is written is kept in memory only while the app runs (the screen's writing store), never on the device.

/// A file attached to a draft, read on this device when the owner picked it, sent with the draft.
public struct MailDraftFile: Equatable, Hashable, Sendable, Identifiable {
    public var id = UUID()
    public var name: String
    public var type: String
    public var data: Data
    public init(name: String, type: String, data: Data) { self.name = name; self.type = type; self.data = data }
    public var size: Int { data.count }
}

/// A file as the hub takes it in a draft: its bytes in base64.
public struct MailDraftFileIn: Codable, Equatable, Sendable {
    public var name: String
    public var type: String
    public var data: String
    public init(name: String, type: String, data: String) { self.name = name; self.type = type; self.data = data }
}

/// `POST /mail/drafts`: a reply (`reply_to`, the hub sets its recipient, subject and thread; `reply_all` adds everyone
/// else it went to), a forward (`forward`, `to`, `forward_attachments`), a new mail (`to`, `subject`, `from`), or a kept
/// draft changed (`replaces`, which of its attachments stay: `keep_parts`, always sent, an empty list too). `preview`:
/// the hub says what it would save, and saves nothing.
public struct MailDraftRequest: Encodable, Equatable, Sendable {
    public var reply_to: String?
    public var reply_all: Bool?
    public var forward: String?
    public var forward_attachments: Bool?
    public var to: String?
    public var subject: String?
    public var replaces: String?
    public var keep_parts: [String]?
    public var from: String?
    public var text: String
    public var greeting: String?
    public var signoff: String?
    public var preview: Bool?
    public var files: [MailDraftFileIn]?
}

/// What the hub saved to Drafts (or, for a preview, would save). `files`: every file on it, a changed draft's kept ones too.
public struct MailDraft: Decodable, Equatable, Sendable {
    public struct File: Decodable, Equatable, Sendable { public var name: String; public var size: Int }
    public var saved: Bool
    public var id: String?
    public var from: MailAddress
    public var to: [String]
    public var cc: [String]
    public var bcc: [String]
    public var subject: String
    public var text: String
    public var files: [File]

    private enum CodingKeys: String, CodingKey { case saved, id, from, to, cc, bcc, subject, text, files }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        saved = (try? c.decodeIfPresent(Bool.self, forKey: .saved)) ?? false
        id = try? c.decodeIfPresent(String.self, forKey: .id)
        from = (try? c.decodeIfPresent(MailAddress.self, forKey: .from)) ?? MailAddress(name: "", address: "")
        to = (try? c.decodeIfPresent([String].self, forKey: .to)) ?? []
        cc = (try? c.decodeIfPresent([String].self, forKey: .cc)) ?? []
        bcc = (try? c.decodeIfPresent([String].self, forKey: .bcc)) ?? []
        subject = (try? c.decodeIfPresent(String.self, forKey: .subject)) ?? ""
        text = (try? c.decodeIfPresent(String.self, forKey: .text)) ?? ""
        files = (try? c.decodeIfPresent([File].self, forKey: .files)) ?? []
    }
}

/// A reply's greeting and sign-off as suggested (`POST /mail/messages/:id/greeting`): by the hub's own model, or the
/// plain ones; `replies`: up to 3 short answers from the same model (none without it), each checked by the hub.
public struct MailGreeting: Decodable, Equatable, Sendable {
    public var greeting: String
    public var signoff: String
    public var replies: [String]

    private enum CodingKeys: String, CodingKey { case greeting, signoff, replies }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        greeting = (try? c.decodeIfPresent(String.self, forKey: .greeting)) ?? ""
        signoff = (try? c.decodeIfPresent(String.self, forKey: .signoff)) ?? ""
        replies = (try? c.decodeIfPresent([String].self, forKey: .replies)) ?? []
    }
}

/// One attachment of an open mail (`GET /mail/messages/:id/attachments`): `preview` a picture's, from the hub.
public struct MailAttachment: Decodable, Equatable, Hashable, Sendable, Identifiable {
    public var part: String
    public var name: String
    public var type: String
    public var size: Int
    public var preview: String?
    public var id: String { part }
    public init(part: String, name: String, type: String = "application/octet-stream", size: Int, preview: String? = nil) {
        self.part = part; self.name = name; self.type = type; self.size = size; self.preview = preview
    }
}

public struct MailAttachmentList: Decodable, Sendable { public var attachments: [MailAttachment] }

extension Mail {
    /// At most this many files, and this many bytes of them together, on a draft (the hub's limits).
    public static let draftFilesMax = 10
    public static let draftFilesBytes = 15 * 1024 * 1024

    /// What a writing box is for: a reply (to the sender, or to all), a forward, a kept draft changed (in the mailbox
    /// `from`), or a new mail.
    public enum DraftFor: Equatable, Sendable {
        case reply(String, all: Bool)
        case forward(String)
        case draft(String, from: String)
        case fresh
    }

    /// What a writing box holds while it is written, kept by the screen (not the box) so a box that closes and opens
    /// again shows what was typed. `greeting` and `signoff` nil: dropped. `touched`: the owner changed them, so a
    /// suggestion arriving later leaves them alone; `suggested`: the hub's suggestions were asked for once; `smart`: the
    /// suggested replies. For a kept draft changed: `ready` once its words are read, `html` when it was written with
    /// formatting in another mail app, `kept` its old attachments still on it (nil: not read yet). `dirty`: the owner
    /// typed words or attached a file, so Discard asks first.
    public struct Writing: Equatable, Sendable {
        public var to = ""
        public var subject = ""
        public var text = ""
        public var greeting: String? = ""
        public var signoff: String? = ""
        public var touchedGreeting = false
        public var touchedSignoff = false
        public var suggested = false
        public var smart: [String] = []
        public var files: [MailDraftFile] = []
        public var withTheirs = false
        public var from = ""
        public var ready = true
        public var html = false
        public var kept: [MailAttachment]? = []
        public var dirty = false
        public init() {}

        /// The bytes of every file on the draft: the owner's and a changed draft's kept ones.
        public var filesBytes: Int { files.reduce(0) { $0 + $1.size } + (kept ?? []).reduce(0) { $0 + $1.size } }
    }

    /// What the hub is asked for a writing box. A greeting or sign-off left empty or dropped is not sent; a changed
    /// draft always says which old attachments it keeps, so none is dropped by being left unsaid; only a new mail from
    /// one of several mailboxes says which (`from`).
    public static func draftRequest(_ what: DraftFor, _ w: Writing, files: [MailDraftFileIn], preview: Bool, from: String? = nil) -> MailDraftRequest {
        var r = MailDraftRequest(text: w.text)
        switch what {
        case .reply(let id, let all):
            r.reply_to = id
            if all { r.reply_all = true }
        case .forward(let id):
            r.forward = id
            r.to = w.to
            if w.withTheirs { r.forward_attachments = true }
        case .draft(let id, let box):
            r.to = w.to; r.subject = w.subject; r.replaces = id
            r.keep_parts = (w.kept ?? []).map(\.part)
            r.from = box
        case .fresh:
            r.to = w.to; r.subject = w.subject
            if let from, !from.isEmpty { r.from = from }
        }
        if let g = w.greeting, !g.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { r.greeting = g }
        if let s = w.signoff, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { r.signoff = s }
        if !files.isEmpty { r.files = files }
        if preview { r.preview = true }
        return r
    }

    /// The writing box's own key: a reply's (Reply and Reply all are one box), a forward's, a changed draft's, a new mail's.
    public static func writingKey(_ what: DraftFor) -> String {
        switch what {
        case .reply(let id, _): return "reply:\(id)"
        case .forward(let id): return "forward:\(id)"
        case .draft(let id, _): return "draft:\(id)"
        case .fresh: return newMailKey
        }
    }
    public static let newMailKey = "new"

    // MARK: Mailboxes in words (mailboxOf and inProvider, issue-22's, are in Mail.swift)

    /// The app a mailbox's drafts are sent from: Apple Mail for an iCloud mailbox, else "your mail app".
    public static func mailApp(_ box: MailMailbox?) -> String { box?.kind == "icloud" ? "Apple Mail" : "your mail app" }

    /// The mailbox a new mail goes from: the one used last time while it is still linked, else the first.
    public static func fromChoice(_ boxes: [MailMailbox], last: String?) -> String {
        boxes.first { $0.email == last }?.email ?? boxes.first?.email ?? ""
    }

    /// Said when the files on a draft are more than the hub takes.
    public static func tooBig(_ box: MailMailbox?) -> String {
        box?.kind == "icloud" ? "The files are more than 15 MB together. Send big files from Apple Mail (Mail Drop)."
            : "The files are more than 15 MB together. Send big files from your mail app."
    }

    // MARK: Files

    /// A size as people read it: 820 KB, 2.4 MB.
    public static func fileSize(_ n: Int) -> String {
        if n < 1024 { return "\(n) B" }
        if n < 1024 * 1024 { return "\(Int((Double(n) / 1024).rounded())) KB" }
        let mb = Double(n) / 1024 / 1024
        return n < 10 * 1024 * 1024 ? String(format: "%.1f MB", mb) : "\(Int(mb.rounded())) MB"
    }

    /// A picture preview as the hub sends it (a data: JPEG, PNG, GIF or WebP), as its bytes, or nil for anything else.
    /// Shown only as a picture.
    public static func previewData(_ v: String?) -> Data? {
        guard let v, v.count < 7_000_000 else { return nil }
        for kind in ["png", "jpeg", "gif", "webp"] {
            let prefix = "data:image/\(kind);base64,"
            guard v.hasPrefix(prefix) else { continue }
            let b64 = v.dropFirst(prefix.count)
            guard !b64.isEmpty, b64.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "+" || $0 == "/" || $0 == "=") }) else { return nil }
            return Data(base64Encoded: String(b64))
        }
        return nil
    }

    /// Kinds of file that can run a program when opened, or hide one, by the end of their name (the web's RISKY_KINDS).
    static let riskyKinds: Set<String> = Set([
        // Programs, installers and what they load.
        "exe com scr pif cpl msi msix msixbundle appx appxbundle msp mst gadget application appref-ms jar jnlp app command action workflow pkg mpkg deb rpm apk xapk ipa appimage run bin elf out dll sys drv ocx",
        // Scripts, and files a script host runs.
        "bat cmd ps1 ps1xml ps2 ps2xml psc1 psc2 psd1 psm1 vbs vbe vb js jse mjs cjs ws wsf wsc wsh hta sct sh bash zsh csh ksh fish py pyc pyo pyw pyz rb pl pm php lua tcl applescript scpt scptd ahk au3 reg inf ins isp msc",
        // Shortcuts: they open or run something else.
        "lnk url webloc inetloc desktop website scf library-ms search-ms searchconnector-ms settingcontent-ms theme themepack diagcab",
        // Old Office files and the newer ones made for macros: both can hold macros.
        "doc dot wbk xls xlt xla xll xlm xlw slk iqy ppt pot pps ppa mdb mde accdb accde adp pub one onepkg docm dotm xlsm xlsb xltm xlam pptm potm ppsm ppam sldm",
        // Pages: a browser runs their scripts when they are opened.
        "html htm xhtml xht shtml mht mhtml svg svgz chm hlp",
        // Disk images and archives: what is inside is not seen until they are opened.
        "iso img vhd vhdx vmdk dmg toast cab zip zipx rar 7z tar gz tgz bz2 tbz tbz2 xz txz zst lz lzh arj ace z cpio wim",
    ].joined(separator: " ").split(separator: " ").map(String.init))

    /// Whether a file can run a program when opened, or hide one: by its name's real ending (dots and spaces after it
    /// are not part of it: "setup.exe." opens as a program), and any name written with characters that change the
    /// direction text is drawn in (it can show another ending than it has).
    public static func riskyFile(_ name: String) -> Bool {
        let turns: Set<UInt32> = [0x200E, 0x200F, 0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2066, 0x2067, 0x2068, 0x2069]
        if name.unicodeScalars.contains(where: { turns.contains($0.value) }) { return true }
        var n = Substring(name)
        while let last = n.last, last == "." || last.isWhitespace { n = n.dropLast() }
        guard let dot = n.lastIndex(of: ".") else { return false }
        return riskyKinds.contains(n[n.index(after: dot)...].lowercased())
    }
}
