import Foundation

private struct IdsBody: Encodable { var ids: [String] }
private struct SeenManyBody: Encodable { var ids: [String]; var seen: Bool }
private struct SeenBody: Encodable { var seen: Bool }
private struct PinBody: Encodable { var pinned: Bool }
private struct UntilBody: Encodable { var until: String }
private struct NotifyBody: Encodable { var people: Bool?; var detail: String?; var bundle: String?; var on: Bool? }
private struct BundleBody: Encodable { var name: String; var color: Int; var addresses: [String]; var domains: [String]; var words: [String] }
private struct MoveBody: Encodable { var ids: [String]; var to: String; var undo: Bool? }
private struct SenderBody: Encodable { var sender: String }
private struct UnsubscribeBody: Encodable { var how: String; var direct: Bool?; var send: Bool? = nil }
private struct UnsubscribeSent: Decodable { var outbox: MailOutboxItem }
private struct OnBody: Encodable { var on: Bool }
private struct FoldBody: Encodable { var lines: [String]; var no_fold: Bool }
private struct Empty: Codable {}
private struct Ignored: Decodable {}

// MARK: The Mail screen (module mail_inbox)
// Every answer is kept in memory by the screen only: nothing of a mail is written on the device (the hub sessions keep
// no URL cache, HTTPTransport.sessionConfiguration).
extension HubClient {
    /// A mail's id in a path: the hub's ids are hex, and anything else is escaped so it stays one path part.
    static func mailPath(_ id: String, _ rest: String = "") -> String {
        let safe = id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
        return "mail/messages/\(safe)\(rest)"
    }

    /// A bundle's id in a path (`c-` and hex for the owner's own, a word for the built-in ones).
    private static func bundlePath(_ id: String) -> String {
        id.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-"))) ?? ""
    }

    public func mailList() async throws -> MailList { try await get("mail", as: MailList.self) }

    public func mailMessage(_ id: String) async throws -> MailMessage { try await get(Self.mailPath(id), as: MailMessage.self) }

    public func mailRefresh() async throws -> MailRefresh { try await post("mail/refresh", Empty(), as: MailRefresh.self) }

    /// Show pictures, on a hub without Tor: the hub fetches this one mail's web pictures straight from its sender,
    /// who then sees the home's internet address. The answer is the message with them written in.
    public func mailShowPictures(_ id: String) async throws -> MailMessage { try await post(Self.mailPath(id, "/pictures"), Empty(), as: MailMessage.self) }

    /// Done: the mails move to Archive in iCloud (a Sweep is many at once). At most `Mail.batchMax` ids.
    public func mailDone(_ ids: [String]) async throws -> MailMoved { try await post("mail/done", IdsBody(ids: ids), as: MailMoved.self) }

    /// Undo, or Move to Inbox from Done: the mails move back from Archive to the Inbox.
    public func mailUndo(_ ids: [String]) async throws -> MailMoved { try await post("mail/undo", IdsBody(ids: ids), as: MailMoved.self) }

    /// Snooze a thread until a time: on the hub only, with a task that says only "Snoozed mail".
    public func mailSnooze(_ id: String, until: Date) async throws {
        _ = try await post(Self.mailPath(id, "/snooze"), UntilBody(until: ISO.string(until)), as: Ignored.self)
    }

    /// Back to the Inbox now; its task is deleted.
    public func mailUnsnooze(_ id: String) async throws { _ = try await post(Self.mailPath(id, "/unsnooze"), Empty(), as: Ignored.self) }

    /// Several messages read or unread with one request (a thread's unread mails, a selection): at most `Mail.batchMax`.
    public func mailSeen(_ ids: [String], seen: Bool) async throws { _ = try await post("mail/seen", SeenManyBody(ids: ids, seen: seen), as: Ignored.self) }

    /// One message read or unread: on the hub, and in the mailbox (only its read flag).
    public func mailSeen(_ id: String, seen: Bool) async throws { _ = try await post(Self.mailPath(id, "/seen"), SeenBody(seen: seen), as: Ignored.self) }

    /// Pin or unpin a thread: kept on the hub only.
    public func mailPin(_ id: String, pinned: Bool) async throws { _ = try await post(Self.mailPath(id, "/pin"), PinBody(pinned: pinned), as: Ignored.self) }

    /// The owner's own bundles: add, change, delete.
    public func mailBundleAdd(name: String, color: Int, addresses: [String], domains: [String], words: [String]) async throws -> MailCustomBundle {
        try await post("mail/settings/custom-bundles", BundleBody(name: name, color: color, addresses: addresses, domains: domains, words: words), as: MailCustomBundle.self)
    }

    public func mailBundleUpdate(_ b: MailCustomBundle) async throws -> MailCustomBundle {
        try await post("mail/settings/custom-bundles/\(Self.bundlePath(b.id))", BundleBody(name: b.name, color: b.color, addresses: b.addresses, domains: b.domains, words: b.words), as: MailCustomBundle.self, method: "PUT")
    }

    public func mailBundleDelete(_ id: String) async throws {
        _ = try await send("DELETE", "mail/settings/custom-bundles/\(Self.bundlePath(id))")
    }

    /// New-mail notifications: `people`, `detail`, or one bundle's switch (`bundle` with `on`).
    @discardableResult
    public func mailNotify(people: Bool? = nil, detail: MailNotify.Detail? = nil, bundle: String? = nil, on: Bool? = nil) async throws -> MailNotify {
        try await post("mail/settings/notify", NotifyBody(people: people, detail: detail?.rawValue, bundle: bundle, on: on), as: MailNotify.self, method: "PUT")
    }

    /// When a bundle's mail shows in the Inbox.
    @discardableResult
    public func mailBundleDelivery(_ bundle: String, _ d: MailBundleDelivery) async throws -> [String: MailBundleDelivery] {
        try await post("mail/settings/bundles/\(Self.bundlePath(bundle))", d, as: [String: MailBundleDelivery].self, method: "PUT")
    }

    // MARK: Writing: drafts, and sending (since 2026-11-24)

    /// A draft: with `preview`, what the hub would save (or send); else saved to the mailbox's Drafts folder. Its files
    /// go in the body, base64, at most 15 MB of them.
    public func mailDraft(_ r: MailDraftRequest) async throws -> MailDraft { try await post("mail/drafts", r, as: MailDraft.self) }

    /// Send: the same mail (without `preview`) into the hub's outbox, sent 10 seconds later unless taken back.
    public func mailSend(_ r: MailDraftRequest) async throws -> MailSent { try await post("mail/send", r, as: MailSent.self) }
    /// A mail in the outbox: waiting, being sent, sent, or not sent with the hub's words. Nil when it is not there.
    public func mailOutbox(_ id: String) async throws -> MailOutboxItem? {
        do { return try await get(Self.outboxPath(id), as: MailOutboxItem.self) } catch HubError.http(status: 404, _) { return nil }
    }
    /// Undo while it waits, or Edit and Discard once it was not sent: it leaves the outbox.
    public func mailOutboxUndo(_ id: String) async throws { _ = try await post(Self.outboxPath(id, "/undo"), Empty(), as: Ignored.self) }
    /// Try again: a mail that was not sent waits again, with its Undo.
    public func mailOutboxRetry(_ id: String) async throws -> MailOutboxItem { try await post(Self.outboxPath(id, "/retry"), Empty(), as: MailOutboxItem.self) }
    /// Save draft: a mail that was not sent goes to Drafts as it is.
    public func mailOutboxDraft(_ id: String) async throws { _ = try await post(Self.outboxPath(id, "/draft"), Empty(), as: Ignored.self) }
    static func outboxPath(_ id: String, _ rest: String = "") -> String { "mail/outbox/\(id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")\(rest)" }

    /// A reply's greeting and sign-off, suggested by the hub's own model (or the plain ones), with up to 3 short replies.
    public func mailGreeting(_ id: String) async throws -> MailGreeting { try await post(Self.mailPath(id, "/greeting"), Empty(), as: MailGreeting.self) }

    /// An open mail's attachments now, with its pictures' previews (read from the mailbox by the hub, kept nowhere).
    public func mailAttachments(_ id: String) async throws -> [MailAttachment] { try await get(Self.mailPath(id, "/attachments"), as: MailAttachmentList.self).attachments }

    /// One attachment's bytes, only when the owner asks for it (Download). Never kept by the app: the owner saves it.
    public func mailAttachment(_ id: String, part: String) async throws -> Data {
        try await send("GET", Self.mailPath(id, "/attachments/" + (part.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "."))) ?? "")))
    }

    // MARK: Folders, moves, unsubscribe and block

    /// One of the mailboxes' other folders: its kept mail, newest first.
    public func mailFolder(_ key: String) async throws -> [MailFolderMail] {
        try await get("mail/folders/\(key.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")", as: MailFolderList.self).messages
    }

    /// Delete (`trash`), Spam (`junk`), Not spam and Move to Inbox (`inbox`), or Move to one of the owner's folders (its
    /// key): a move in the mailbox, nothing erased. `undo`: this takes back a move just made, so the hub puts the mail
    /// back as it was. At most `Mail.batchMax` ids.
    public func mailMove(_ ids: [String], to: String, undo: Bool = false) async throws -> MailMovedTo {
        try await post("mail/move", MoveBody(ids: ids, to: to, undo: undo ? true : nil), as: MailMovedTo.self)
    }

    /// The ways a mail offers to unsubscribe, read from it now; then one of them (`direct`: the owner accepted that the
    /// sender sees the home's address, on a hub without Tor).
    public func mailUnsubscribeOptions(_ id: String) async throws -> MailUnsubscribeOptions { try await get(Self.mailPath(id, "/unsubscribe"), as: MailUnsubscribeOptions.self) }
    public func mailUnsubscribe(_ id: String, how: String, direct: Bool = false) async throws -> MailUnsubscribed {
        try await post(Self.mailPath(id, "/unsubscribe"), UnsubscribeBody(how: how, direct: direct ? true : nil), as: MailUnsubscribed.self)
    }
    /// The mail to the sender's unsubscribe address, into the hub's outbox (since 2026-11-24): sent 10 seconds later
    /// unless taken back (`mailOutboxUndo`), like Send.
    public func mailUnsubscribeSend(_ id: String) async throws -> MailOutboxItem {
        try await post(Self.mailPath(id, "/unsubscribe"), UnsubscribeBody(how: "mailto", send: true), as: UnsubscribeSent.self).outbox
    }

    /// Block a sender (an address, or `@domain`): their mail goes to Spam, now and from now on. Unblock: it stops.
    public func mailBlock(_ sender: String) async throws -> MailBlocked { try await post("mail/settings/blocked", SenderBody(sender: sender), as: MailBlocked.self) }
    public func mailUnblock(_ sender: String) async throws { _ = try await post("mail/settings/unblock", SenderBody(sender: sender), as: Ignored.self) }

    // MARK: Search, sorting and folding notes

    /// Every kept mail with each word of `q` (whole texts, Inbox and folders), or all mail with one person (`with`).
    public func mailSearch(_ q: String, with person: String = "") async throws -> [MailSearchHit] {
        try await get("mail/search", query: ["q": q.isEmpty ? nil : q, "with": person.isEmpty ? nil : person], as: MailSearchHits.self).hits
    }

    /// Triage on or off (off erases every kept triage).
    public func mailTriage(_ on: Bool) async throws { _ = try await post("mail/settings/triage", OnBody(on: on), as: Ignored.self, method: "PUT") }

    /// Sort new mail now: the hub's model runs because the owner asked. Answers at once with how sorting stands.
    public func mailTriageNow() async throws -> MailTriageState { try await post("mail/triage", Empty(), as: MailTriageState.self) }

    /// "Something important missing?": a folding note on a mail; every note; clearing them. Kept on the hub only.
    public func mailFolding(_ id: String, lines: [String], noFold: Bool) async throws { _ = try await post(Self.mailPath(id, "/folding"), FoldBody(lines: lines, no_fold: noFold), as: Ignored.self) }
    public func mailFoldNotes() async throws -> [MailFoldNoteEntry] { try await get("mail/folding-notes", as: MailFoldNotes.self).notes }
    public func mailClearFoldNotes() async throws { _ = try await send("DELETE", "mail/folding-notes") }

    /// The owner's snooze times (what "Tomorrow" and the rest mean).
    @discardableResult
    public func mailSnoozeTimes(_ t: MailSnoozeTimes) async throws -> MailSnoozeTimes {
        try await post("mail/settings/snooze", t, as: MailSnoozeTimes.self, method: "PUT")
    }
}
