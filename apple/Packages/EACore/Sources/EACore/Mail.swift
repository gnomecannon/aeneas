import Foundation

// The Mail screen's types and the small rules it shows mail by (CONTRACT.md, Mail), the same as the web's
// web/src/lib/mail.ts, so every app sorts, groups and links mail alike. Mail is hostile input: everything here is
// shown as text, never as HTML or Markdown, and only links these rules checked are opened, outside the app.
//
// Nothing of a mail is kept on the device: these values live in memory while the screen shows them.

// MARK: - What the hub sends

public struct MailAddress: Codable, Equatable, Hashable, Sendable {
    public var name: String
    public var address: String
    public init(name: String, address: String) { self.name = name; self.address = address }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? ""
        address = (try? c.decodeIfPresent(String.self, forKey: .address)) ?? ""
    }
}

/// Where a mail is. `sent` is the owner's own reply, shown only inside its thread; `folder` is mail of one of the
/// mailbox's other folders (`GET /mail/folders/:key`, a search hit), never in the list. A state a newer hub adds reads
/// as done, so it never shows in the Inbox by mistake.
public enum MailState: String, Codable, Sendable {
    case inbox, snoozed, done, sent, folder

    public init(from decoder: Decoder) throws {
        self = MailState(rawValue: (try? decoder.singleValueContainer().decode(String.self)) ?? "") ?? .done
    }
}

/// One message in the list (`GET /mail`): no text, `preview` is its first words; `bundle` is the bundle the hub
/// sorted it into.
public struct MailSummary: Codable, Equatable, Hashable, Sendable, Identifiable {
    public var id: String
    public var at: String
    public var from: MailAddress
    public var reply_to: String?
    public var subject: String
    public var preview: String
    public var automated: Bool
    public var bundle: String?
    public var state: MailState
    public var pinned: Bool
    public var snooze_until: String?
    /// The sender's verified brand logo (the list's `logos` by this domain).
    public var logo_domain: String?
    /// When it came back from a snooze: the Inbox lists it by this, not by when it arrived.
    public var back_at: String?
    /// Read (opened in an app, or read in another mail app). An older hub leaves it out: then everything shows as read.
    public var seen: Bool?
    /// Its thread: messages with the same one show as one row.
    public var thread: String?
    /// The owner's own reply (from Sent).
    public var mine: Bool?
    /// How many attachments it has (the row's paperclip); nil when none, or when not known yet (`attachmentsUnknown`).
    public var attachments: Int?
    /// The hub does not know yet whether it has attachments (mail kept before they were listed): asked once, on opening.
    public var attachmentsUnknown: Bool
    /// Its key facts (a package, a flight, a bill), from the sender's own data or its text.
    public var cards: [MailCard]?
    /// The hub's model's triage (kept a week): how soon it matters, what it is in a line, whether it needs a reply.
    public var triage: MailTriage?
    /// The mailbox it is in, by its address (one of the list's `mailboxes`). An older hub leaves it out.
    public var mailbox: String?

    public init(id: String, at: String, from: MailAddress, reply_to: String? = nil, subject: String = "", preview: String = "", automated: Bool = false,
                bundle: String? = nil, state: MailState = .inbox, pinned: Bool = false, snooze_until: String? = nil, logo_domain: String? = nil,
                back_at: String? = nil, seen: Bool? = nil, thread: String? = nil, mine: Bool? = nil, attachments: Int? = nil, attachmentsUnknown: Bool = false,
                cards: [MailCard]? = nil, triage: MailTriage? = nil, mailbox: String? = nil) {
        self.id = id; self.at = at; self.from = from; self.reply_to = reply_to; self.subject = subject; self.preview = preview
        self.automated = automated; self.bundle = bundle; self.state = state; self.pinned = pinned; self.snooze_until = snooze_until
        self.logo_domain = logo_domain; self.back_at = back_at; self.seen = seen; self.thread = thread; self.mine = mine
        self.attachments = attachments; self.attachmentsUnknown = attachmentsUnknown; self.cards = cards; self.triage = triage; self.mailbox = mailbox
    }

    private enum CodingKeys: String, CodingKey {
        case id, at, from, reply_to, subject, preview, automated, bundle, state, pinned, snooze_until, logo_domain, back_at, seen, thread, mine
        case attachments, cards, triage, mailbox
    }

    // Only the id is needed to show a row; a field a mail lacks falls back, so one odd mail never empties the list.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        at = (try? c.decodeIfPresent(String.self, forKey: .at)) ?? ""
        from = (try? c.decodeIfPresent(MailAddress.self, forKey: .from)) ?? MailAddress(name: "", address: "")
        reply_to = try? c.decodeIfPresent(String.self, forKey: .reply_to)
        subject = (try? c.decodeIfPresent(String.self, forKey: .subject)) ?? ""
        preview = (try? c.decodeIfPresent(String.self, forKey: .preview)) ?? ""
        automated = (try? c.decodeIfPresent(Bool.self, forKey: .automated)) ?? false
        // A bundle under an id a build of the renaming used for a few days is that bundle (Mail.bundleIdAsSent).
        bundle = (try? c.decodeIfPresent(String.self, forKey: .bundle)).map(Mail.bundleIdAsSent)
        state = (try? c.decodeIfPresent(MailState.self, forKey: .state)) ?? .inbox
        pinned = (try? c.decodeIfPresent(Bool.self, forKey: .pinned)) ?? false
        snooze_until = try? c.decodeIfPresent(String.self, forKey: .snooze_until)
        logo_domain = try? c.decodeIfPresent(String.self, forKey: .logo_domain)
        back_at = try? c.decodeIfPresent(String.self, forKey: .back_at)
        seen = try? c.decodeIfPresent(Bool.self, forKey: .seen)
        thread = try? c.decodeIfPresent(String.self, forKey: .thread)
        mine = try? c.decodeIfPresent(Bool.self, forKey: .mine)
        // Absent: none. null: not known yet (asked on opening). A number: how many.
        attachments = (try? c.decodeIfPresent(Int.self, forKey: .attachments)).flatMap { $0 > 0 ? $0 : nil }
        attachmentsUnknown = c.contains(.attachments) && ((try? c.decodeNil(forKey: .attachments)) ?? false)
        cards = (try? c.decodeIfPresent([MailCard].self, forKey: .cards)).flatMap { $0.isEmpty ? nil : $0 }
        triage = try? c.decodeIfPresent(MailTriage.self, forKey: .triage)
        mailbox = try? c.decodeIfPresent(String.self, forKey: .mailbox)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id); try c.encode(at, forKey: .at); try c.encode(from, forKey: .from)
        try c.encodeIfPresent(reply_to, forKey: .reply_to); try c.encode(subject, forKey: .subject); try c.encode(preview, forKey: .preview)
        try c.encode(automated, forKey: .automated); try c.encodeIfPresent(bundle, forKey: .bundle); try c.encode(state, forKey: .state)
        try c.encode(pinned, forKey: .pinned); try c.encodeIfPresent(snooze_until, forKey: .snooze_until); try c.encodeIfPresent(logo_domain, forKey: .logo_domain)
        try c.encodeIfPresent(back_at, forKey: .back_at); try c.encodeIfPresent(seen, forKey: .seen); try c.encodeIfPresent(thread, forKey: .thread)
        try c.encodeIfPresent(mine, forKey: .mine)
        if attachmentsUnknown { try c.encodeNil(forKey: .attachments) } else { try c.encodeIfPresent(attachments, forKey: .attachments) }
        try c.encodeIfPresent(cards, forKey: .cards); try c.encodeIfPresent(triage, forKey: .triage); try c.encodeIfPresent(mailbox, forKey: .mailbox)
    }

    public var isMine: Bool { mine == true }
    /// Whether opening it asks the hub for its attachments: it has some, or the hub does not know yet.
    public var asksForAttachments: Bool { attachmentsUnknown || (attachments ?? 0) > 0 }
}

/// One message whole (`GET /mail/messages/:id`). `html`: the mail as sent, cleaned by the hub into a page that loads
/// nothing (its pictures written in), or nil when it has none; `pictures_pending`: the hub is still fetching its web
/// pictures (through Tor); `pictures_ask`: the hub has no Tor, so it fetches them only when asked (Show pictures);
/// `quote_at`: where the quoted history starts in `text` (in characters as JavaScript counts them).
public struct MailMessage: Decodable, Equatable, Sendable {
    public var summary: MailSummary
    public var text: String
    public var html: String?
    public var pictures_pending: Bool
    public var pictures_ask: Bool
    public var quote_at: Int?
    /// The owner said not to fold this mail (a folding note): it shows unfolded, its page too.
    public var no_fold: Bool

    public init(summary: MailSummary, text: String, html: String? = nil, pictures_pending: Bool = false, pictures_ask: Bool = false, quote_at: Int? = nil, no_fold: Bool = false) {
        self.summary = summary; self.text = text; self.html = html; self.pictures_pending = pictures_pending; self.pictures_ask = pictures_ask; self.quote_at = quote_at
        self.no_fold = no_fold
    }

    private enum CodingKeys: String, CodingKey { case text, html, pictures_pending, pictures_ask, quote_at, no_fold }

    public init(from decoder: Decoder) throws {
        summary = try MailSummary(from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        text = (try? c.decodeIfPresent(String.self, forKey: .text)) ?? ""
        html = try? c.decodeIfPresent(String.self, forKey: .html)
        pictures_pending = (try? c.decodeIfPresent(Bool.self, forKey: .pictures_pending)) ?? false
        pictures_ask = (try? c.decodeIfPresent(Bool.self, forKey: .pictures_ask)) ?? false
        quote_at = try? c.decodeIfPresent(Int.self, forKey: .quote_at)
        no_fold = (try? c.decodeIfPresent(Bool.self, forKey: .no_fold)) ?? false
    }

    /// The text without its quoted history (folded behind a button), or whole when it has none. `quote_at` counts
    /// UTF-16 units, as JavaScript does, so it is read that way here.
    public var ownText: String {
        guard let q = quote_at, q >= 0 else { return text }
        let u = text.utf16
        guard q <= u.count, let end = u.index(u.startIndex, offsetBy: q, limitedBy: u.endIndex), let s = String(u[u.startIndex..<end]) else { return text }
        return String(s.reversed().drop { $0.isWhitespace }.reversed())
    }
}

/// A mailbox's state: `more` says the last refresh left new mail for the next one (a big Inbox comes in batches).
/// `provider`: who keeps it, as the screen says it ("iCloud", "Gmail", or the server's name); `kind`: how it is
/// linked ("icloud", "gmail" or "imap"). An older hub sends neither.
public struct MailMailbox: Codable, Equatable, Hashable, Sendable {
    public var email: String
    public var last_refresh: String?
    public var last_error: String?
    public var more: Bool
    public var provider: String?
    public var kind: String?
    /// Read only (Settings, Accounts, since 2026-11-24): the hub refuses every change to it, so the screen offers
    /// none. Nil from an older hub.
    public var read_only: Bool?

    public init(email: String, last_refresh: String? = nil, last_error: String? = nil, more: Bool = false, provider: String? = nil, kind: String? = nil, read_only: Bool? = nil) {
        self.email = email; self.last_refresh = last_refresh; self.last_error = last_error; self.more = more
        self.provider = provider; self.kind = kind; self.read_only = read_only
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        email = (try? c.decodeIfPresent(String.self, forKey: .email)) ?? ""
        last_refresh = try? c.decodeIfPresent(String.self, forKey: .last_refresh)
        last_error = try? c.decodeIfPresent(String.self, forKey: .last_error)
        more = (try? c.decodeIfPresent(Bool.self, forKey: .more)) ?? false
        provider = try? c.decodeIfPresent(String.self, forKey: .provider)
        kind = try? c.decodeIfPresent(String.self, forKey: .kind)
        read_only = try? c.decodeIfPresent(Bool.self, forKey: .read_only)
    }
}

/// What the snooze choices mean, as the owner set them on the hub (days 0 Sunday to 6 Saturday, times `HH:MM`).
public struct MailSnoozeTimes: Codable, Equatable, Hashable, Sendable {
    public var later_hours: Int
    public var tomorrow: String
    public var weekend_day: Int
    public var weekend_time: String
    public var week_day: Int
    public var week_time: String

    public static let defaults = MailSnoozeTimes(later_hours: 3, tomorrow: "08:00", weekend_day: 6, weekend_time: "09:00", week_day: 1, week_time: "08:00")

    public init(later_hours: Int, tomorrow: String, weekend_day: Int, weekend_time: String, week_day: Int, week_time: String) {
        self.later_hours = later_hours; self.tomorrow = tomorrow; self.weekend_day = weekend_day
        self.weekend_time = weekend_time; self.week_day = week_day; self.week_time = week_time
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = Self.defaults
        later_hours = (try? c.decodeIfPresent(Int.self, forKey: .later_hours)) ?? d.later_hours
        tomorrow = (try? c.decodeIfPresent(String.self, forKey: .tomorrow)) ?? d.tomorrow
        weekend_day = (try? c.decodeIfPresent(Int.self, forKey: .weekend_day)) ?? d.weekend_day
        weekend_time = (try? c.decodeIfPresent(String.self, forKey: .weekend_time)) ?? d.weekend_time
        week_day = (try? c.decodeIfPresent(Int.self, forKey: .week_day)) ?? d.week_day
        week_time = (try? c.decodeIfPresent(String.self, forKey: .week_time)) ?? d.week_time
    }
}

/// When a bundle's mail shows in the Inbox: as it arrives, once a day at `time`, once a week on `day` at `time`, never.
public struct MailBundleDelivery: Codable, Equatable, Hashable, Sendable {
    public enum Mode: String, Codable, CaseIterable, Sendable {
        case now, daily, weekly, never
        public init(from decoder: Decoder) throws {
            self = Mode(rawValue: (try? decoder.singleValueContainer().decode(String.self)) ?? "") ?? .now
        }
    }
    public var mode: Mode
    public var time: String?
    public var day: Int?
    public init(mode: Mode, time: String? = nil, day: Int? = nil) { self.mode = mode; self.time = time; self.day = day }
}

/// A bundle of the owner's, as the hub keeps it: a name, a color (0 to 7), and its rules.
public struct MailCustomBundle: Codable, Equatable, Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var color: Int
    public var addresses: [String]
    public var domains: [String]
    public var words: [String]

    public init(id: String, name: String, color: Int, addresses: [String] = [], domains: [String] = [], words: [String] = []) {
        self.id = id; self.name = name; self.color = color; self.addresses = addresses; self.domains = domains; self.words = words
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? id
        color = (try? c.decodeIfPresent(Int.self, forKey: .color)) ?? 0
        addresses = (try? c.decodeIfPresent([String].self, forKey: .addresses)) ?? []
        domains = (try? c.decodeIfPresent([String].self, forKey: .domains)) ?? []
        words = (try? c.decodeIfPresent([String].self, forKey: .words)) ?? []
    }
}

/// Which new mail notifies (mail from people; bundles switched on, while they show as mail arrives) and what it says.
public struct MailNotify: Codable, Equatable, Hashable, Sendable {
    public enum Detail: String, Codable, CaseIterable, Sendable {
        case full, sender, count
        public init(from decoder: Decoder) throws {
            self = Detail(rawValue: (try? decoder.singleValueContainer().decode(String.self)) ?? "") ?? .full
        }
    }
    public var people: Bool
    public var bundles: [String]
    public var detail: Detail

    public static let defaults = MailNotify(people: true, bundles: [], detail: .full)
    public init(people: Bool, bundles: [String], detail: Detail) { self.people = people; self.bundles = bundles; self.detail = detail }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        people = (try? c.decodeIfPresent(Bool.self, forKey: .people)) ?? true
        var seen = Set<String>()
        bundles = ((try? c.decodeIfPresent([String].self, forKey: .bundles)) ?? []).map(Mail.bundleIdAsSent).filter { seen.insert($0).inserted }
        detail = (try? c.decodeIfPresent(Detail.self, forKey: .detail)) ?? .full
    }
}

/// `GET /mail`. `logos`: the verified brand logos the messages use, by domain (a message's `logo_domain`). `folders`:
/// the mailboxes' other folders; `blocked`: the senders whose mail goes to Spam; `triage`: whether the hub's model sorts
/// new mail (the switch), `triage_state`: how that stands now (an older hub sends neither).
public struct MailList: Decodable, Equatable, Sendable {
    public var messages: [MailSummary]
    public var mailboxes: [MailMailbox]
    public var logos: [String: String]
    public var snooze_times: MailSnoozeTimes
    public var bundle_delivery: [String: MailBundleDelivery]
    public var custom_bundles: [MailCustomBundle]
    public var mail_notify: MailNotify
    public var folders: [MailFolder]
    public var blocked: [String]
    public var triage: Bool?
    public var triage_state: MailTriageState?

    public init(messages: [MailSummary], mailboxes: [MailMailbox], logos: [String: String] = [:], snooze_times: MailSnoozeTimes = .defaults,
                bundle_delivery: [String: MailBundleDelivery] = [:], custom_bundles: [MailCustomBundle] = [], mail_notify: MailNotify = .defaults,
                folders: [MailFolder] = [], blocked: [String] = [], triage: Bool? = nil, triage_state: MailTriageState? = nil) {
        self.messages = messages; self.mailboxes = mailboxes; self.logos = logos; self.snooze_times = snooze_times
        self.bundle_delivery = bundle_delivery; self.custom_bundles = custom_bundles; self.mail_notify = mail_notify
        self.folders = folders; self.blocked = blocked; self.triage = triage; self.triage_state = triage_state
    }

    private enum CodingKeys: String, CodingKey { case messages, mailboxes, logos, snooze_times, bundle_delivery, custom_bundles, mail_notify, folders, blocked, triage, triage_state }

    // The settings came one release at a time (2026-11-19 and 20): a hub without one of them gives its defaults.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        messages = try c.decode([MailSummary].self, forKey: .messages)
        mailboxes = (try? c.decodeIfPresent([MailMailbox].self, forKey: .mailboxes)) ?? []
        logos = (try? c.decodeIfPresent([String: String].self, forKey: .logos)) ?? [:]
        snooze_times = (try? c.decodeIfPresent(MailSnoozeTimes.self, forKey: .snooze_times)) ?? .defaults
        bundle_delivery = Mail.deliveryAsSent((try? c.decodeIfPresent([String: MailBundleDelivery].self, forKey: .bundle_delivery)) ?? [:])
        custom_bundles = (try? c.decodeIfPresent([MailCustomBundle].self, forKey: .custom_bundles)) ?? []
        mail_notify = (try? c.decodeIfPresent(MailNotify.self, forKey: .mail_notify)) ?? .defaults
        folders = (try? c.decodeIfPresent([MailFolder].self, forKey: .folders)) ?? []
        blocked = (try? c.decodeIfPresent([String].self, forKey: .blocked)) ?? []
        triage = try? c.decodeIfPresent(Bool.self, forKey: .triage)
        triage_state = try? c.decodeIfPresent(MailTriageState.self, forKey: .triage_state)
    }
}

/// What Done or Undo did: the mails moved, how many were not, and the hub's words when some were not.
public struct MailMoved: Codable, Equatable, Sendable {
    public var moved: [String]
    public var failed: Int
    public var error: String?
    public init(moved: [String], failed: Int = 0, error: String? = nil) { self.moved = moved; self.failed = failed; self.error = error }
}

/// `POST /mail/refresh`: per mailbox what came and went, or the hub's own words for what went wrong.
public struct MailRefresh: Decodable, Equatable, Sendable {
    public struct Box: Decodable, Equatable, Sendable {
        public var email: String
        public var kept: Int?
        public var gone: Int?
        public var more: Bool?
        public var error: String?
    }
    public var mailboxes: [Box]

    /// The line the screen shows after a Refresh, as the web words it.
    public var summary: (ok: Bool, text: String) {
        let failed = mailboxes.filter { $0.error != nil }.count
        if failed > 0 {
            return (false, "\(failed == 1 ? "A mailbox" : "\(failed) mailboxes") could not be refreshed. Mailboxes and settings has why.")
        }
        let kept = mailboxes.reduce(0) { $0 + ($1.kept ?? 0) }
        return (true, kept > 0 ? "\(kept) new." : "Nothing new.")
    }
}

// MARK: - Threads

/// A list row's mail: a single message, or a thread read as its representative message.
public protocol MailRowItem {
    var summary: MailSummary { get }
}

extension MailSummary: MailRowItem {
    public var summary: MailSummary { self }
}

/// A thread as one row: it reads like a mail (its newest received one in the thread's state: id, sender, bundle) so the
/// day groups, bundles and views work as for single mail, with its messages (`members`, oldest first, the owner's
/// replies among them) and the ids each action takes.
public struct MailThread: MailRowItem, Equatable, Hashable, Identifiable, Sendable {
    public var summary: MailSummary
    public var members: [MailSummary]
    /// "Alex, me (3)": who wrote, in order, the owner as "me".
    public var people: String
    /// Done and Snooze: the thread's mail in the Inbox or snoozed; Move to Inbox: its done mail; read on opening: its unread.
    public var openIds: [String]
    public var doneIds: [String]
    public var unreadIds: [String]
    /// What the screen knows the row by (selected, open, its writing box shown): its thread, else its one mail's id. It
    /// stays the same while mail comes and goes in the thread; `id` is its newest received mail's, which the hub's
    /// actions take, and changes when another arrives (web/src/lib/mail.ts MailThread.key, kept the same).
    public var key: String

    public var id: String { summary.id }
    public var state: MailState { summary.state }
    public var pinned: Bool { summary.pinned }
    public var isUnread: Bool { Mail.isUnread(summary) }
}

public enum Mail {
    /// The hub takes at most this many ids in one Done, Undo or read mark.
    public static let batchMax = 500
    /// How many of a thread's unread messages open by themselves, the newest ones; the rest open with a tap.
    public static let openUnreadMax = 3
    /// The tallest a mail's page gets, in points (a long newsletter is 10,000 to 15,000); a longer one scrolls inside.
    public static let pageMax: Double = 30_000
    /// The quoted history in a mail's page, as mail apps mark it: the hub's page folds it while its body has
    /// `aeneas-fold` (hub/src/mail-html.ts QUOTE_SELECTOR and web/src/lib/mail.ts, kept the same).
    public static let quoteSelector = ".gmail_quote, blockquote[type=\"cite\"], .moz-cite-prefix, .yahoo_quoted, #divRplyFwdMsg, #divRplyFwdMsg ~ *"

    /// Where every kind of mailbox is added: Settings, Accounts, on every device (gnomecannon/aeneas#23 and #10; the
    /// Apple apps had only iCloud Mail and Sign in with Google, and sent people to another app for Gmail).
    public static let otherAccountsWhere = "iCloud, Gmail and other mail accounts are added in Settings, Accounts, with an app password."
    /// The Mail screen with no mailbox linked, above Add an account: where each kind of mailbox is linked (web
    /// NO_MAILBOX, kept the same).
    public static let noMailboxText = "No mailbox is linked yet. \(otherAccountsWhere) Their mail then shows here."

    /// Whether the mailbox a mail is in is Read only: its Done, Pin and other changes are not offered (web readOnlyBox).
    public static func readOnly(_ boxes: [MailMailbox], _ email: String?) -> Bool { mailboxOf(boxes, email)?.read_only == true }
    /// Said when a change is held back from a Read only mailbox (the hub's own words for it, kept the same).
    public static func readOnlyText(_ email: String?) -> String {
        "\(email ?? "This mailbox") is set to Read only in Settings, Accounts, so Aeneas changes nothing in it. Switch Read only off there to do this."
    }

    /// Unread: the hub says it has not been read.
    public static func isUnread(_ m: MailSummary) -> Bool { m.seen == false }

    /// The mailbox a mail is in: the one it names, else the only one linked. With several linked and none named, not
    /// known. (web/src/lib/mail.ts mailboxOf, kept the same.)
    public static func mailboxOf(_ boxes: [MailMailbox], _ email: String?) -> MailMailbox? {
        guard let email, !email.isEmpty else { return boxes.count == 1 ? boxes[0] : nil }
        return boxes.first { $0.email.lowercased() == email.lowercased() }
    }

    /// Where a mailbox's mail is kept, in words: "in iCloud", "in Gmail", or "in your mailbox" when its provider is not
    /// known (an older hub, or several mailboxes and the mail names none). The screen said "in iCloud" for every
    /// mailbox (gnomecannon/aeneas#22). (web/src/lib/mail.ts inProvider, kept the same.)
    public static func inProvider(_ box: MailMailbox?) -> String {
        let p = box?.provider?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return p.isEmpty ? "in your mailbox" : "in \(p)"
    }

    /// How a person is named in the list: their name, else their address.
    public static func personLabel(_ p: MailAddress) -> String {
        let n = p.name.trimmingCharacters(in: .whitespacesAndNewlines)
        return n.isEmpty ? p.address : n
    }

    /// Messages into threads. A thread's state is the Inbox while any of its received mail is there, else Snoozed,
    /// else Done; it is unread while any received message is; pinned when any is; a person's mail in it keeps it out
    /// of the bundles. The owner's own replies never make a thread on their own.
    public static func threads(_ messages: [MailSummary]) -> [MailThread] {
        var order: [String] = []
        var groups: [String: [MailSummary]] = [:]
        for m in messages {
            let k = m.thread ?? m.id
            if groups[k] == nil { order.append(k) }
            groups[k, default: []].append(m)
        }
        var out: [MailThread] = []
        for k in order {
            let members = (groups[k] ?? []).enumerated().sorted { a, b in a.element.at == b.element.at ? a.offset < b.offset : a.element.at < b.element.at }.map(\.element)
            let received = members.filter { !$0.isMine && $0.state != .sent }
            guard !received.isEmpty, let last = members.last else { continue }
            let state: MailState = received.contains { $0.state == .inbox } ? .inbox : received.contains { $0.state == .snoozed } ? .snoozed : .done
            guard let base = received.last(where: { $0.state == state }) else { continue }
            let person = received.contains { !$0.automated }
            var names: [String] = []
            for m in members {
                let n: String
                if m.isMine { n = "me" }
                else if members.count > 1 {
                    let first = personLabel(m.from).split(whereSeparator: { $0.isWhitespace }).first.map(String.init) ?? ""
                    n = first.isEmpty ? m.from.address : first
                } else { n = personLabel(m.from) }
                if !names.contains(n) { names.append(n) }
            }
            var s = base
            s.subject = members[0].subject
            s.preview = last.isMine ? "You: \(last.preview)" : last.preview
            s.at = last.at > base.at ? last.at : base.at
            s.pinned = received.contains { $0.pinned }
            s.seen = received.allSatisfy { $0.seen != false }
            s.automated = !person
            s.bundle = person ? nil : base.bundle
            // The paperclip counts the whole thread's attachments; not known for any one, not known for the thread.
            s.attachmentsUnknown = members.contains { $0.attachmentsUnknown }
            s.attachments = s.attachmentsUnknown ? nil : members.reduce(0) { $0 + ($1.attachments ?? 0) }
            if s.attachments == 0 { s.attachments = nil }
            out.append(MailThread(
                summary: s, members: members,
                people: members.count > 1 ? "\(names.joined(separator: ", ")) (\(members.count))" : (names.first ?? ""),
                openIds: received.filter { $0.state == .inbox || $0.state == .snoozed }.map(\.id),
                doneIds: received.filter { $0.state == .done }.map(\.id),
                unreadIds: received.filter { $0.seen == false }.map(\.id),
                key: k))
        }
        return out
    }

    /// The time a mail is listed by in the Inbox: when it came back from a snooze, else when it arrived.
    public static func shownAt(_ m: MailSummary) -> String {
        if let b = m.back_at, b > m.at { return b }
        return m.at
    }

    /// A list in pieces of at most `batchMax`, so a selection of any size goes through.
    public static func batches<T>(_ items: [T], size: Int = batchMax) -> [[T]] {
        stride(from: 0, to: items.count, by: max(size, 1)).map { Array(items[$0..<min($0 + size, items.count)]) }
    }

    // MARK: Snooze

    /// A snooze choice: "Tomorrow" at 8 AM and so on.
    public struct SnoozeChoice: Equatable, Hashable, Sendable, Identifiable {
        public var id: String
        public var label: String
        public var at: Date
    }

    /// The snooze choices from `now`: Later today (3 hours on, on the hour; only before 9 PM), Tomorrow 8 AM, This
    /// weekend (Saturday 9 AM; next Saturday when it is the weekend), Next week (Monday 8 AM), as the owner set them.
    public static func snoozeChoices(now: Date = Date(), times: MailSnoozeTimes = .defaults, calendar cal: Calendar = .current) -> [SnoozeChoice] {
        func at(_ days: Int, _ hhmm: String) -> Date {
            let (h, m) = clock(hhmm)
            let day = cal.date(byAdding: .day, value: days, to: now) ?? now
            return cal.date(bySettingHour: h, minute: m, second: 0, of: day) ?? day
        }
        var out: [SnoozeChoice] = []
        let hour = cal.component(.hour, from: now)
        let topOfHour = cal.date(bySettingHour: hour, minute: 0, second: 0, of: now) ?? now
        let later = cal.date(byAdding: .hour, value: times.later_hours, to: topOfHour) ?? now
        if cal.isDate(later, inSameDayAs: now), cal.component(.hour, from: later) < 21 {
            out.append(SnoozeChoice(id: "later", label: "Later today", at: later))
        }
        out.append(SnoozeChoice(id: "tomorrow", label: "Tomorrow", at: at(1, times.tomorrow)))
        let day = cal.component(.weekday, from: now) - 1 // 0 Sunday to 6 Saturday, as the hub counts
        let weekendNow = day == 6 || day == 0
        let toWeekend = (times.weekend_day - day + 7) % 7
        out.append(SnoozeChoice(id: "weekend", label: weekendNow ? "Next weekend" : "This weekend", at: at(toWeekend == 0 ? 7 : toWeekend, times.weekend_time)))
        let toWeek = (times.week_day - day + 7) % 7
        out.append(SnoozeChoice(id: "nextweek", label: "Next week", at: at(toWeek == 0 ? 7 : toWeek, times.week_time)))
        return out
    }

    /// `HH:MM` as hour and minute; anything else is midnight.
    static func clock(_ hhmm: String?) -> (Int, Int) {
        let p = (hhmm ?? "").split(separator: ":").map { Int($0) ?? 0 }
        return (p.first ?? 0, p.count > 1 ? p[1] : 0)
    }

    // MARK: When a bundle shows

    /// When mail that arrived at `at` shows under `d`: the next delivery time from then (nil: never).
    public static func deliveryAt(_ at: String, _ d: MailBundleDelivery?, calendar cal: Calendar = .current) -> Date? {
        // A time that does not read shows as it is (listed by its own time), unless its bundle never shows.
        guard let arrived = ISO.date(at) else { return d?.mode == .never ? nil : .distantPast }
        guard let d, d.mode != .now else { return arrived }
        if d.mode == .never { return nil }
        let (h, m) = clock(d.time)
        var t = cal.date(bySettingHour: h, minute: m, second: 0, of: arrived) ?? arrived
        if d.mode == .daily {
            if t < arrived { t = cal.date(byAdding: .day, value: 1, to: t) ?? t }
            return t
        }
        let weekday = cal.component(.weekday, from: t) - 1
        t = cal.date(byAdding: .day, value: ((d.day ?? 0) - weekday + 7) % 7, to: t) ?? t
        if t < arrived { t = cal.date(byAdding: .day, value: 7, to: t) ?? t }
        return t
    }

    /// When a mail shows in the Inbox (an ISO time), or nil while it is held (its bundle shows later) or never there
    /// (its bundle skips the Inbox). Pinned mail always shows; a person's mail is in no bundle.
    public static func inboxAt(_ m: MailSummary, delivery: [String: MailBundleDelivery] = [:], now: Date = Date(), calendar: Calendar = .current) -> String? {
        let listed = shownAt(m)
        guard !m.pinned, let bundle = m.bundle else { return listed }
        guard let at = deliveryAt(m.at, delivery[bundle], calendar: calendar) else { return nil }
        if at > now { return nil }
        let iso = ISO.string(at)
        return iso > listed ? iso : listed
    }

    // MARK: Bundles

    /// A bundle: a colored group of one kind of mail. The always-there ones, then the ones tied to a module, shown
    /// only while that module is on (`module`), with a link to its screen; then the owner's own (`custom`: its color,
    /// 0 to 7). Updates takes automated mail nothing stronger claimed, the social networks' too.
    ///
    /// An id is what the hub and the kept settings know a bundle by, so it stays when the bundle is renamed: since
    /// 2026-11-22 `purchases` is called Transactions, `promos` Promotions and `other` Updates, and there is no
    /// Social bundle (the hub's list is `BUNDLE_IDS` in hub/src/mail-bundles.ts; a test holds the two together).
    public struct Bundle: Equatable, Hashable, Sendable, Identifiable {
        public var id: String
        public var name: String
        public var module: String?
        public var moduleName: String?
        public var custom: Int?
        public init(id: String, name: String, module: String? = nil, moduleName: String? = nil, custom: Int? = nil) {
            self.id = id; self.name = name; self.module = module; self.moduleName = moduleName; self.custom = custom
        }
    }

    public static let bundles: [Bundle] = [
        Bundle(id: "purchases", name: "Transactions"),
        Bundle(id: "other", name: "Updates"),
        Bundle(id: "promos", name: "Promotions"),
        Bundle(id: "trips", name: "Trips"),
        Bundle(id: "bills", name: "Bills", module: "renewals", moduleName: "Renewals and bills"),
        Bundle(id: "pet", name: "Pet", module: "pet", moduleName: "Pet"),
        Bundle(id: "jobs", name: "Jobs", module: "jobs", moduleName: "Job search"),
    ]

    /// The ids a build of the renaming used for a few days (2026-11-22), by the id every app knows the bundle by.
    /// A hub running that build sends them (its list, its kept settings, its alerts), and an app that read them as
    /// bundles it has no view for listed all of their mail on its own, none of it bundled (gnomecannon/aeneas#7).
    /// The hub takes them the same way (`SHORT_LIVED_BUNDLE_IDS` in hub/src/mail-bundles.ts; a test holds the two
    /// together).
    public static let shortLivedBundleIds: [String: String] = ["transactions": "purchases", "updates": "other", "promotions": "promos"]

    /// A bundle id as the hub sends it today: a short-lived one is the bundle's real id, any other stays as it is.
    public static func bundleIdAsSent(_ id: String) -> String { shortLivedBundleIds[id] ?? id }

    /// Bundle delivery settings under the real ids. A setting under the real id wins over one under a short-lived id.
    public static func deliveryAsSent(_ d: [String: MailBundleDelivery]) -> [String: MailBundleDelivery] {
        var out: [String: MailBundleDelivery] = [:]
        for (k, v) in d where shortLivedBundleIds[k] != nil && d[bundleIdAsSent(k)] == nil { out[bundleIdAsSent(k)] = v }
        for (k, v) in d where shortLivedBundleIds[k] == nil { out[k] = v }
        return out
    }

    /// The bundles shown: the always-there ones, a module's only while it is on, then the owner's own.
    public static func shownBundles(on: (String) -> Bool, custom: [MailCustomBundle] = []) -> [Bundle] {
        bundles.filter { $0.module.map(on) ?? true } + custom.map { Bundle(id: $0.id, name: $0.name, custom: $0.color) }
    }

    /// The bundle a message shows in, or nil: an unknown bundle, or one whose module is off, shows the mail on its own.
    public static func bundleOf(_ m: MailSummary, in shown: [Bundle]) -> Bundle? {
        guard let b = m.bundle else { return nil }
        return shown.first { $0.id == b }
    }

    // MARK: The list

    /// What the screen shows: the Inbox, Snoozed, Done, one bundle, or one of the mailboxes' other folders (by its key).
    public enum Place: Hashable, Sendable {
        case inbox, snoozed, done
        case bundle(String)
        case folder(String)
    }

    /// The heading a message is under: Today, Yesterday, This week, This month, then the month ("October 2026").
    public static func dayGroup(_ iso: String, now: Date = Date(), calendar cal: Calendar = .current) -> String {
        guard let d = ISO.date(iso) else { return "Earlier" }
        let n = daysBefore(d, now, cal)
        if n <= 0 { return "Today" }
        if n == 1 { return "Yesterday" }
        if n < 7 { return "This week" }
        if cal.component(.month, from: d) == cal.component(.month, from: now), cal.component(.year, from: d) == cal.component(.year, from: now) { return "This month" }
        return d.formatted(Date.FormatStyle(calendar: cal, timeZone: cal.timeZone).month(.wide).year())
    }

    /// The time beside a message: the hour today, the weekday this week, else the date.
    public static func whenLabel(_ iso: String, now: Date = Date(), calendar cal: Calendar = .current) -> String {
        guard let d = ISO.date(iso) else { return "" }
        let n = daysBefore(d, now, cal)
        let style = Date.FormatStyle(calendar: cal, timeZone: cal.timeZone)
        if n <= 0 { return d.formatted(style.hour().minute()) }
        if n < 7 { return d.formatted(style.weekday(.abbreviated)) }
        if cal.component(.year, from: d) != cal.component(.year, from: now) { return d.formatted(style.month(.abbreviated).day().year()) }
        return d.formatted(style.month(.abbreviated).day())
    }

    private static func daysBefore(_ d: Date, _ now: Date, _ cal: Calendar) -> Int {
        cal.dateComponents([.day], from: cal.startOfDay(for: d), to: cal.startOfDay(for: now)).day ?? 0
    }

    /// The letter in a sender's circle: the first letter or digit of their name or address.
    public static func initial(_ from: MailAddress) -> String {
        personLabel(from).first { $0.isLetter || $0.isNumber }.map { String($0).uppercased() } ?? "?"
    }

    /// The letters in a sender's circle, as Apple Mail draws them: the first letters of the first and last words of
    /// their name ("Alumni Relations Team" gives AT), or one letter when the name is one word or only an address.
    public static func initials(_ from: MailAddress) -> String {
        let words = from.name.split(whereSeparator: { $0.isWhitespace }).compactMap { w in w.first { $0.isLetter || $0.isNumber } }
        if words.count >= 2, let a = words.first, let b = words.last { return (String(a) + String(b)).uppercased() }
        return initial(from)
    }

    /// A verified brand logo as the hub sends it (a data: SVG), as its bytes, or nil for anything else. It is shown
    /// only as a picture, never as a page.
    public static func logoData(_ v: String?) -> Data? {
        let prefix = "data:image/svg+xml;base64,"
        guard let v, v.count < 200_000, v.hasPrefix(prefix) else { return nil }
        let b64 = v.dropFirst(prefix.count)
        guard !b64.isEmpty, b64.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "+" || $0 == "/" || $0 == "=") }) else { return nil }
        return Data(base64Encoded: String(b64))
    }

    /// Whether a message has every word of a search, in its sender, subject or first words (case aside).
    public static func matches(_ m: MailSummary, _ q: String) -> Bool {
        let words = q.lowercased().split(whereSeparator: { $0.isWhitespace })
        if words.isEmpty { return true }
        let hay = "\(m.from.name) \(m.from.address) \(m.subject) \(m.preview)".lowercased()
        return words.allSatisfy { hay.contains($0) }
    }

    /// A row of the Inbox: one message, or a bundle with its messages (newest first).
    public enum Row<T: MailRowItem> {
        case mail(T)
        case bundle(Bundle, [T])
    }

    public struct DaySection<T: MailRowItem> {
        public var title: String
        public var rows: [Row<T>]
        public init(title: String, rows: [Row<T>]) { self.title = title; self.rows = rows }
    }

    /// The hold-back settings that count in this app: those of the bundles it shows. Mail of a bundle this app has no
    /// view for is never held back (it would show nowhere until its time), so everything that asks when a mail shows
    /// asks with these: the list, and the count of new mail beside Inbox.
    public static func shownDelivery(_ delivery: [String: MailBundleDelivery], shown: [Bundle]) -> [String: MailBundleDelivery] {
        delivery.filter { d in shown.contains { $0.id == d.key } }
    }

    /// The Inbox as the screen lists it: newest first, under day headings. A bundle is one row, where its newest
    /// message is in each day; pinned mail always stands on its own. With `pinnedOnly`, only pinned mail, none bundled.
    public static func inboxSections<T: MailRowItem>(_ messages: [T], shown: [Bundle], pinnedOnly: Bool = false, now: Date = Date(),
                                                     delivery: [String: MailBundleDelivery] = [:], calendar: Calendar = .current) -> [DaySection<T>] {
        // Each mail at the time it shows: held mail (its bundle shows later) and bundles that skip the Inbox are left out.
        // Only a bundle this app shows can hold its mail back: mail under an id it has no view for (a hub newer than
        // the app, a module off here) would otherwise be out of the Inbox and in no bundle, so nowhere at all.
        let held = shownDelivery(delivery, shown: shown)
        let timed: [(T, String)] = messages.compactMap { m in
            let s = m.summary
            guard s.state == .inbox, !pinnedOnly || s.pinned, let w = inboxAt(s, delivery: held, now: now, calendar: calendar) else { return nil }
            return (m, w)
        }
        let sorted = timed.enumerated().sorted { a, b in a.element.1 == b.element.1 ? a.offset < b.offset : a.element.1 > b.element.1 }.map(\.element)
        var sections: [DaySection<T>] = []
        for (m, when) in sorted {
            let title = dayGroup(when, now: now, calendar: calendar)
            if sections.last?.title != title { sections.append(DaySection(title: title, rows: [])) }
            let i = sections.count - 1
            guard !m.summary.pinned, !pinnedOnly, let b = bundleOf(m.summary, in: shown) else { sections[i].rows.append(.mail(m)); continue }
            if let r = sections[i].rows.firstIndex(where: { if case .bundle(let x, _) = $0 { return x.id == b.id } else { return false } }),
               case .bundle(let x, var mails) = sections[i].rows[r] {
                mails.append(m)
                sections[i].rows[r] = .bundle(x, mails)
            } else {
                sections[i].rows.append(.bundle(b, [m]))
            }
        }
        return sections
    }

    /// The messages a view lists flat (Snoozed soonest first, Done and a bundle newest first; a folder none of these).
    public static func viewMessages<T: MailRowItem>(_ messages: [T], view: Place, shown: [Bundle]) -> [T] {
        func stable(_ xs: [T], _ before: (MailSummary, MailSummary) -> Bool) -> [T] {
            xs.enumerated().sorted { a, b in
                if before(a.element.summary, b.element.summary) { return true }
                if before(b.element.summary, a.element.summary) { return false }
                return a.offset < b.offset
            }.map(\.element)
        }
        switch view {
        case .snoozed: return stable(messages.filter { $0.summary.state == .snoozed }) { ($0.snooze_until ?? "") < ($1.snooze_until ?? "") }
        case .done: return stable(messages.filter { $0.summary.state == .done }) { $0.at > $1.at }
        case .bundle(let id): return stable(messages.filter { $0.summary.state == .inbox && bundleOf($0.summary, in: shown)?.id == id }) { shownAt($0) > shownAt($1) }
        case .inbox: return stable(messages.filter { $0.summary.state == .inbox }) { shownAt($0) > shownAt($1) }
        // A folder lists its own mail (GET /mail/folders/:key), never the Inbox's.
        case .folder: return []
        }
    }

    /// "Northwind, Larkspur Books": who a bundle's mail is from, each name once.
    public static func sendersLine<T: MailRowItem>(_ mails: [T]) -> String {
        var seen: [String] = []
        for m in mails { let n = personLabel(m.summary.from); if !seen.contains(n) { seen.append(n) } }
        return seen.joined(separator: ", ")
    }

    // MARK: Showing a message safely

    /// Where a reply would go, when that is not the sender. Phishing mail often uses it to collect answers at another address.
    public static func replyToWarning(_ m: MailSummary) -> String? {
        guard let r = m.reply_to, r.lowercased() != m.from.address.lowercased() else { return nil }
        return "Replies go to \(r), not to \(m.from.address)."
    }

    /// Whether the sender's shown name looks like an address other than the real one ("support@bank.example" <x@evil>).
    public static func nameHidesAddress(_ from: MailAddress) -> Bool {
        // Letters, digits and the usual address marks only, so brackets around it ("Alex (alex@example.com)") are not part of it.
        guard let r = from.name.range(of: #"[\w.+'-]+@[\w-]+(\.[\w-]+)*\.[a-z]{2,}"#, options: [.regularExpression, .caseInsensitive]) else { return false }
        return from.name[r].lowercased() != from.address.lowercased()
    }

    /// A link from inside a mail's page that the app opens: http, https or mailto, nothing else.
    public static func frameLink(_ href: String?) -> URL? {
        let h = (href ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if h.range(of: #"^mailto:[^\s<>"]{1,500}$"#, options: [.regularExpression, .caseInsensitive]) != nil {
            return URL(string: h)
        }
        guard let u = URL(string: h), let scheme = u.scheme?.lowercased(), scheme == "https" || scheme == "http", let host = u.host, !host.isEmpty else { return nil }
        return u
    }

    /// A link as the screen may open it from a mail's text: https only, a host, no user name; with the host to show
    /// beside it. A host in another alphabet's letters is given in its real form (`xn--`), as a browser reads it.
    public static func httpsLink(_ url: String) -> (href: String, host: String)? {
        guard url.count >= 8, url.prefix(8).lowercased() == "https://" else { return nil }
        let rest = url.dropFirst(8)
        let end = rest.firstIndex { "/?#".contains($0) } ?? rest.endIndex
        let authority = rest[rest.startIndex..<end]
        if authority.contains("@") || authority.isEmpty { return nil }
        var hostPart = Substring(authority), port = ""
        if let colon = authority.lastIndex(of: ":") {
            let p = authority[authority.index(after: colon)...]
            guard p.allSatisfy(\.isNumber) else { return nil }
            hostPart = authority[authority.startIndex..<colon]
            port = p.isEmpty ? "" : ":" + p
        }
        guard let host = Punycode.host(String(hostPart).lowercased()), !host.isEmpty else { return nil }
        var path = String(rest[end...])
        if path.isEmpty || path.first != "/" { path = "/" + path }
        let built = "https://\(host)\(port)\(path)"
        guard let u = URL(string: built), u.host != nil else { return nil }
        return (u.absoluteString, host)
    }

    /// A piece of a line of mail text: plain text, or a link. `warnHost` is shown beside an address whose host is
    /// written in another alphabet's letters.
    public struct TextPart: Equatable, Sendable {
        public var text: String
        public var href: String?
        public var warnHost: String?
        public init(text: String, href: String? = nil, warnHost: String? = nil) { self.text = text; self.href = href; self.warnHost = warnHost }
    }

    private static let addressPattern = try! NSRegularExpression(pattern: #"(https://|www\.)[^\s<>"]+"#, options: [.caseInsensitive])

    /// A line of mail text in pieces, its web addresses as links: `https://…`, and `www.…` (opened as https). The
    /// link's text is the address itself, so a mail cannot show one place and go to another. Anything else (`http:`,
    /// `javascript:`, `mailto:`, a user name in the address) stays plain text. A trailing period, comma or bracket ends
    /// the address. When the host is written in another alphabet, `warnHost` is that real host, to show beside it.
    public static func textParts(_ line: String) -> [TextPart] {
        var out: [TextPart] = []
        func plain(_ t: Substring) {
            guard !t.isEmpty else { return }
            if let last = out.last, last.href == nil { out[out.count - 1].text += t } else { out.append(TextPart(text: String(t))) }
        }
        let ns = line as NSString
        var at = 0
        for m in addressPattern.matches(in: line, range: NSRange(location: 0, length: ns.length)) {
            let start = m.range.location
            // Not the middle of another word or address: "http://www.…", "me@www.…", "awww.…".
            if start > 0, let c = ns.substring(with: NSRange(location: start - 1, length: 1)).first, c.isLetter || c.isNumber || "_.@/:-".contains(c) { continue }
            if start < at { continue }
            var url = ns.substring(with: m.range)
            // Punctuation after an address is the sentence's; a closing bracket only when the address has no opening one.
            while let c = url.last {
                let opens = url.filter { "([{".contains($0) }.count, closes = url.filter { ")]}".contains($0) }.count
                if ".,;:!?'\"\u{2019}\u{201D}".contains(c) || (")]}".contains(c) && opens < closes) { url.removeLast() } else { break }
            }
            guard let link = httpsLink(url.lowercased().hasPrefix("www.") ? "https://\(url)" : url), link.host.contains(".") else { continue }
            plain(Substring(ns.substring(with: NSRange(location: at, length: start - at))))
            let warn = link.host.split(separator: ".").contains { $0.hasPrefix("xn--") } ? link.host : nil
            out.append(TextPart(text: url, href: link.href, warnHost: warn))
            at = start + (url as NSString).length
        }
        plain(Substring(ns.substring(from: at)))
        return out.isEmpty ? [TextPart(text: line)] : out
    }

    // MARK: Reminders in the Inbox

    /// A reminder that is due, as the Inbox shows it: the task's title and when it came due (its snooze, else its time).
    public struct DueReminder: Equatable, Hashable, Sendable, Identifiable {
        public var id: String
        public var title: String
        public var at: Date
        public var friction: String
    }

    /// The owner's reminders whose time has come (overdue ones too): tasks with a reminder time, not done, not snoozed
    /// past now. A task Mail made for a snoozed mail (`mail`) is left out: the mail itself shows. Earliest first.
    public static func dueReminders(_ tasks: [Entity], now: Date = Date()) -> [DueReminder] {
        var out: [DueReminder] = []
        for t in tasks where !t.isDeleted {
            guard t.str("status") != "done", let remind = t.string("remind_at"), t.string("mail") == nil, let remindAt = ISO.date(remind) else { continue }
            var at = remindAt
            if let s = t.date("snoozed_until"), s > remindAt { at = s }
            if at > now { continue }
            let title = t.str("title").trimmingCharacters(in: .whitespacesAndNewlines)
            out.append(DueReminder(id: t.id, title: title.isEmpty ? "(no title)" : title, at: at, friction: t.string("friction") ?? "none"))
        }
        return out.sorted { $0.at < $1.at }
    }

    // MARK: Keyboard (iPad and Mac): letters for actions

    /// What a key does on the Mail screen.
    public enum Key: String, Sendable {
        case escape, open, select, done, snooze, pin, unread, read, delete, spam, search, help
    }

    /// The Mail screen's keys, for the keys list (the web's MAIL_KEYS, in the Mac's names). The arrows move through the
    /// list, and Shift with them selects, as in any list.
    public static let keys: [(keys: String, does: String)] = [
        ("\u{2191} \u{2193}", "Previous / next row"),
        ("Shift + \u{2191} \u{2193}", "Select while moving"),
        ("Return", "Open the thread, or open or close a bundle"),
        ("Esc", "Clear the selection"),
        ("D", "Done (Move to Inbox in Done)"),
        ("S", "Snooze"),
        ("P", "Pin or unpin"),
        ("U / R", "Mark unread / read"),
        ("Delete", "Delete (moves it to Trash)"),
        ("!", "Spam (moves it to Spam)"),
        ("/", "Search mail"),
        ("?", "Show these keys"),
    ]

    /// What a key press on the Mail screen does, or nil for one it leaves to the rest of the app. Never with Control,
    /// Command or Option, and while typing in a field only Escape (which leaves the field). `delete` is the Delete key
    /// (Backspace on other keyboards, also the key that deletes forward).
    public static func keyAction(_ key: String, control: Bool = false, command: Bool = false, option: Bool = false, typing: Bool = false) -> Key? {
        if control || command || option { return nil }
        if key == "escape" { return .escape }
        if typing { return nil }
        switch key {
        case "return": return .open
        case " ": return .select
        case "/": return .search
        case "?": return .help
        case "!": return .spam
        case "delete", "backspace", "deleteForward": return .delete
        default: break
        }
        switch key.lowercased() {
        case "d": return .done
        case "s": return .snooze
        case "p": return .pin
        case "u": return .unread
        case "r": return .read
        default: return nil
        }
    }
}

/// Host names in another alphabet's letters as a browser reads them (RFC 3492 Punycode, `xn--`), so a look-alike
/// address shows its real form beside it.
enum Punycode {
    /// The host with each label that is not plain ASCII written as `xn--…`, or nil for one that cannot be a host.
    static func host(_ host: String) -> String? {
        var labels: [String] = []
        for label in host.split(separator: ".", omittingEmptySubsequences: false) {
            if label.allSatisfy(\.isASCII) {
                guard label.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }) else { return nil }
                labels.append(String(label))
            } else {
                guard let p = encode(String(label)) else { return nil }
                labels.append("xn--" + p)
            }
        }
        return labels.joined(separator: ".")
    }

    static func encode(_ input: String) -> String? {
        let base = 36, tmin = 1, tmax = 26, skew = 38, damp = 700
        let scalars = input.precomposedStringWithCompatibilityMapping.lowercased().unicodeScalars.map { Int($0.value) }
        var output = scalars.filter { $0 < 0x80 }.map { Character(UnicodeScalar(UInt8($0))) }
        let b = output.count
        var h = b
        if b > 0 { output.append("-") }
        var n = 0x80, delta = 0, bias = 72
        func digit(_ d: Int) -> Character { Character(UnicodeScalar(UInt8(d < 26 ? d + 97 : d + 22))) }
        func adapt(_ d0: Int, _ numPoints: Int, _ first: Bool) -> Int {
            var d = first ? d0 / damp : d0 / 2
            d += d / numPoints
            var k = 0
            while d > ((base - tmin) * tmax) / 2 { d /= base - tmin; k += base }
            return k + (base - tmin + 1) * d / (d + skew)
        }
        while h < scalars.count {
            guard let m = scalars.filter({ $0 >= n }).min() else { return nil }
            delta += (m - n) * (h + 1)
            n = m
            for c in scalars {
                if c < n { delta += 1 }
                if c == n {
                    var q = delta, k = base
                    while true {
                        let t = k <= bias ? tmin : (k >= bias + tmax ? tmax : k - bias)
                        if q < t { break }
                        output.append(digit(t + (q - t) % (base - t)))
                        q = (q - t) / (base - t)
                        k += base
                    }
                    output.append(digit(q))
                    bias = adapt(delta, h + 1, h == b)
                    delta = 0
                    h += 1
                }
            }
            delta += 1
            n += 1
        }
        return String(output)
    }
}
