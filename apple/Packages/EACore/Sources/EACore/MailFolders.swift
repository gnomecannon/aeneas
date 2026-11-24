import Foundation

// The mailboxes' other folders (Drafts, Sent, Spam, Trash and the owner's own) and what moves mail between places:
// Delete, Spam, Not spam, Move to, Unsubscribe and Block, and searching all kept mail. The same rules as the web's
// (web/src/lib/mail.ts), so every app names, counts and moves mail alike (CONTRACT.md, Mail).

/// The part a folder plays: Drafts, Sent, Junk (shown as Spam), Trash, or one of the owner's own (`own`). A part a newer
/// hub adds reads as the owner's own, which offers the least.
public enum MailFolderRole: String, Codable, Sendable {
    case drafts, sent, junk, trash, own
    public init(from decoder: Decoder) throws {
        self = MailFolderRole(rawValue: (try? decoder.singleValueContainer().decode(String.self)) ?? "") ?? .own
    }
}

/// One of a mailbox's other folders (`GET /mail` `folders`): `email` the mailbox it belongs to, `name` its own name
/// (shown for the owner's own), `count` its kept mail, `unread` how much of it is unread.
public struct MailFolder: Codable, Equatable, Hashable, Sendable, Identifiable {
    public var key: String
    public var email: String
    public var role: MailFolderRole
    public var name: String
    public var count: Int
    public var unread: Int
    public var more: Bool
    public var id: String { key }

    public init(key: String, email: String, role: MailFolderRole, name: String = "", count: Int = 0, unread: Int = 0, more: Bool = false) {
        self.key = key; self.email = email; self.role = role; self.name = name; self.count = count; self.unread = unread; self.more = more
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        email = (try? c.decodeIfPresent(String.self, forKey: .email)) ?? ""
        role = (try? c.decodeIfPresent(MailFolderRole.self, forKey: .role)) ?? .own
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? ""
        count = (try? c.decodeIfPresent(Int.self, forKey: .count)) ?? 0
        unread = (try? c.decodeIfPresent(Int.self, forKey: .unread)) ?? 0
        more = (try? c.decodeIfPresent(Bool.self, forKey: .more)) ?? false
    }
}

/// A folder's mail (`GET /mail/folders/:key`): a list entry, with who it went to (`to`, for the owner's own in Sent and
/// Drafts) and its folder's part.
public struct MailFolderMail: Decodable, Equatable, Hashable, Sendable, Identifiable {
    public var summary: MailSummary
    public var to: [MailAddress]
    public var folder_role: MailFolderRole
    public var id: String { summary.id }

    public init(summary: MailSummary, to: [MailAddress] = [], folder_role: MailFolderRole) {
        self.summary = summary; self.to = to; self.folder_role = folder_role
    }

    private enum CodingKeys: String, CodingKey { case to, folder_role }
    public init(from decoder: Decoder) throws {
        summary = try MailSummary(from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        to = (try? c.decodeIfPresent([MailAddress].self, forKey: .to)) ?? []
        folder_role = (try? c.decodeIfPresent(MailFolderRole.self, forKey: .folder_role)) ?? .own
    }

    /// The owner's own (Sent, Drafts): its row names who it went to.
    public var isOwners: Bool { folder_role == .sent || folder_role == .drafts }
}

public struct MailFolderList: Decodable, Sendable { public var messages: [MailFolderMail] }

/// What a move did (`POST /mail/move`): the mails moved, how many were not (with the hub's words), and each moved mail's
/// new id where the hub keeps it (`to`, for Undo).
public struct MailMovedTo: Decodable, Equatable, Sendable {
    public var moved: [String]
    public var failed: Int
    public var error: String?
    public var to: [String: String]
    public init(moved: [String], failed: Int = 0, error: String? = nil, to: [String: String] = [:]) { self.moved = moved; self.failed = failed; self.error = error; self.to = to }

    private enum CodingKeys: String, CodingKey { case moved, failed, error, to }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        moved = (try? c.decodeIfPresent([String].self, forKey: .moved)) ?? []
        failed = (try? c.decodeIfPresent(Int.self, forKey: .failed)) ?? 0
        error = try? c.decodeIfPresent(String.self, forKey: .error)
        to = (try? c.decodeIfPresent([String: String].self, forKey: .to)) ?? [:]
    }
}

/// What blocking a sender did: the blocked list now, how many of their mails moved to Spam (and how many did not, with
/// the hub's words), and where each moved mail is now (`to`, as a move gives it). An older hub sends only the list and
/// the count.
public struct MailBlocked: Decodable, Equatable, Sendable {
    public var blocked: [String]
    public var moved: Int
    public var failed: Int
    public var to: [String: String]
    public var error: String?
    public init(blocked: [String], moved: Int, failed: Int = 0, to: [String: String] = [:], error: String? = nil) {
        self.blocked = blocked; self.moved = moved; self.failed = failed; self.to = to; self.error = error
    }

    private enum CodingKeys: String, CodingKey { case blocked, moved, failed, to, error }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        blocked = (try? c.decodeIfPresent([String].self, forKey: .blocked)) ?? []
        moved = (try? c.decodeIfPresent(Int.self, forKey: .moved)) ?? 0
        failed = (try? c.decodeIfPresent(Int.self, forKey: .failed)) ?? 0
        to = (try? c.decodeIfPresent([String: String].self, forKey: .to)) ?? [:]
        error = try? c.decodeIfPresent(String.self, forKey: .error)
    }
}

/// How a mail can be unsubscribed from (`GET /mail/messages/:id/unsubscribe`), read from it now, and whether the hub
/// goes through Tor.
public struct MailUnsubscribeOptions: Decodable, Equatable, Sendable {
    public struct Host: Decodable, Equatable, Sendable { public var host: String }
    public struct To: Decodable, Equatable, Sendable { public var to: String; public var subject: String? }
    public var one_click: Host?
    public var link: String?
    public var mailto: To?
    public var tor: Bool

    private enum CodingKeys: String, CodingKey { case one_click, link, mailto, tor }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        one_click = try? c.decodeIfPresent(Host.self, forKey: .one_click)
        link = try? c.decodeIfPresent(String.self, forKey: .link)
        mailto = try? c.decodeIfPresent(To.self, forKey: .mailto)
        tor = (try? c.decodeIfPresent(Bool.self, forKey: .tor)) ?? false
    }
}

/// What an unsubscribe did: `via` Tor or straight from the hub (one click), or a draft saved (a mail to their address).
public struct MailUnsubscribed: Decodable, Equatable, Sendable {
    public var ok: Bool
    public var via: String?
    public var draft: Bool?
}

/// A search hit (`GET /mail/search`): a list entry, where it is, and a snippet around the first match; `to` for the
/// owner's own (Sent, Drafts, a reply in a thread).
public struct MailSearchHit: Decodable, Equatable, Hashable, Sendable, Identifiable {
    public var summary: MailSummary
    public var where_: String
    public var folder_name: String?
    public var snippet: String
    public var to: [MailAddress]
    public var id: String { summary.id }

    public init(summary: MailSummary, where_: String, folder_name: String? = nil, snippet: String = "", to: [MailAddress] = []) {
        self.summary = summary; self.where_ = where_; self.folder_name = folder_name; self.snippet = snippet; self.to = to
    }

    private enum CodingKeys: String, CodingKey { case where_ = "where", folder_name, snippet, to }
    public init(from decoder: Decoder) throws {
        summary = try MailSummary(from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        where_ = (try? c.decodeIfPresent(String.self, forKey: .where_)) ?? ""
        folder_name = try? c.decodeIfPresent(String.self, forKey: .folder_name)
        snippet = (try? c.decodeIfPresent(String.self, forKey: .snippet)) ?? ""
        to = (try? c.decodeIfPresent([MailAddress].self, forKey: .to)) ?? []
    }

    /// The owner's own mail (a reply, Sent, a draft): its row names who it went to.
    public var isOwners: Bool { (summary.isMine || where_ == "drafts") && !to.isEmpty }
    /// In the Inbox, Snoozed or Done: it can be shown where it is listed.
    public var isListed: Bool { ["inbox", "snoozed", "done"].contains(where_) }
}

public struct MailSearchHits: Decodable, Sendable { public var hits: [MailSearchHit] }

extension Mail {
    /// The fewest characters a search needs before every kept mail is searched on the hub.
    public static let searchEverywhereFrom = 3
    /// The hub answers at most this many hits.
    public static let searchMax = 200

    // MARK: Folders

    /// A folder's name on the screen: Drafts, Sent, Spam (the server's Junk), Trash, or the owner's own; with its
    /// mailbox when several are linked.
    public static func folderLabel(_ f: MailFolder, many: Bool = false) -> String {
        let name: String
        switch f.role {
        case .drafts: name = "Drafts"
        case .sent: name = "Sent"
        case .junk: name = "Spam"
        case .trash: name = "Trash"
        case .own: name = f.name
        }
        return many ? "\(name) (\(f.email))" : name
    }

    /// The number a folder shows in the side list: its drafts, else its unread mail (none in Sent or Trash).
    public static func folderCount(_ f: MailFolder) -> Int {
        switch f.role {
        case .drafts: return f.count
        case .trash, .sent: return 0
        case .junk, .own: return f.unread
        }
    }

    /// Who a folder row names: those it went to for the owner's own (Sent, Drafts), else its sender.
    public static func folderWho(_ m: MailFolderMail) -> String {
        guard m.isOwners else { return personLabel(m.summary.from) }
        let to = m.to.map(personLabel).joined(separator: ", ")
        return "To: \(to.isEmpty ? "(no one yet)" : to)"
    }

    /// What a folder's mail can do, by its folder: go to the Inbox (Not spam in Spam, Move to Inbox in Trash and the
    /// owner's own), Delete (everywhere but Trash itself), with an Undo (not from Sent or Drafts, where nothing may be
    /// moved back in), and Move to another of the owner's folders (from one of the owner's own).
    public struct FolderActs: Equatable, Sendable {
        public var inbox: Bool
        public var trash: Bool
        public var undo: Bool
        public var move: Bool
        public init(inbox: Bool, trash: Bool, undo: Bool, move: Bool) { self.inbox = inbox; self.trash = trash; self.undo = undo; self.move = move }
        /// Nothing: a Read only mailbox's folders.
        public static let none = FolderActs(inbox: false, trash: false, undo: false, move: false)
    }
    public static func folderActs(_ role: MailFolderRole) -> FolderActs {
        FolderActs(inbox: role == .junk || role == .trash || role == .own, trash: role != .trash, undo: role != .sent && role != .drafts, move: role == .own)
    }

    /// Where a folder's mail goes back to on Undo (and the place `POST /mail/move` names it by).
    public static func moveTarget(_ f: MailFolder) -> String { f.role == .own ? f.key : f.role.rawValue }

    /// The owner's folders that mail can move to: those of the one mailbox all of the mail is in (`mailboxes`: each
    /// mail's, by address), but `except` (the folder it is in now). Mail from several mailboxes, or from one that is not
    /// known, has no folder to move to.
    public static func moveFolders(_ folders: [MailFolder], mailboxes: [String?], except: String? = nil) -> [MailFolder] {
        let of = Set(mailboxes.map { $0?.lowercased() })
        guard of.count == 1, let only = of.first, let box = only else { return [] }
        return folders.filter { $0.role == .own && $0.key != except && $0.email.lowercased() == box }
    }

    /// The other folders by mailbox, each mailbox once, in the order of `boxes` (as the hub lists them); a mailbox not
    /// among them comes after, in the order its first folder comes.
    public static func folderGroups(_ folders: [MailFolder], boxes: [MailMailbox] = []) -> [(email: String, folders: [MailFolder])] {
        var out: [(email: String, folders: [MailFolder])] = []
        for f in folders {
            if let i = out.firstIndex(where: { $0.email.lowercased() == f.email.lowercased() }) { out[i].folders.append(f) } else { out.append((f.email, [f])) }
        }
        func place(_ e: String) -> Int { boxes.firstIndex { $0.email.lowercased() == e.lowercased() } ?? boxes.count }
        return out.enumerated().sorted { a, b in
            let pa = place(a.element.email), pb = place(b.element.email)
            return pa == pb ? a.offset < b.offset : pa < pb
        }.map(\.element)
    }

    // MARK: Read only mailboxes

    /// The mailboxes a draft can be saved to: the ones that are not Read only (web writableBoxes).
    public static func writableBoxes(_ boxes: [MailMailbox]) -> [MailMailbox] { boxes.filter { $0.read_only != true } }

    /// Of some mail (by id), those in a Read only mailbox: the hub refuses every change to them, so the screen leaves
    /// them out of a move and says why. `mails`: every mail the screen holds, which says each one's mailbox.
    public static func readOnlyIds(_ ids: [String], mails: [MailSummary], boxes: [MailMailbox]) -> [String] {
        var box: [String: String?] = [:]
        for m in mails where box[m.id] == nil { box[m.id] = m.mailbox }
        return ids.filter { readOnly(boxes, box[$0] ?? nil) }
    }

    /// Sweep: every unpinned thread here marked done at once (pinned ones stay, and a Read only mailbox's mail stays).
    public static func sweepIds(_ ts: [MailThread], boxes: [MailMailbox]) -> [String] {
        ts.filter { !$0.pinned && $0.state != .done && !readOnly(boxes, $0.summary.mailbox) }.flatMap(\.openIds)
    }

    /// The mail a move would take words with: each moved mail's whole thread (a reply is written under any of its
    /// messages), those of them with words not saved to Drafts (`unsaved`). Moving them asks first.
    public static func writtenUnder(_ ids: [String], threads: [MailThread], unsaved: (String) -> Bool) -> [String] {
        var out: [String] = []
        for id in ids {
            let all = threads.first { $0.members.contains { $0.id == id } }?.members.map(\.id) ?? [id]
            for m in all where unsaved(m) && !out.contains(m) { out.append(m) }
        }
        return out
    }

    /// The Undo bar's words after a move: the screen's own for one mail ("Moved to Trash"), with the count for more
    /// ("3 moved to Trash").
    public static func movedText(_ said: String, count: Int) -> String {
        count == 1 ? said : "\(count) \(said.prefix(1).lowercased())\(said.dropFirst())"
    }

    /// The Undo bar after a block: its words (how many moved, when any did), and the mail to move back out of Spam once
    /// the sender is unblocked (each one's new id the hub gave).
    public static func blockUndo(_ r: MailBlocked, who: String) -> (text: String, back: [String]) {
        (r.moved > 0 ? "Blocked \(who): \(r.moved) moved to Spam" : "Blocked \(who)", r.to.keys.sorted().compactMap { r.to[$0] })
    }

    // MARK: Search

    /// Where a hit is, as the screen names it ("Inbox", "Spam", the owner's folder's name); the owner's reply in a
    /// thread is "Your reply".
    public static func whereLabel(_ h: MailSearchHit) -> String {
        switch h.where_ {
        case "own": return h.folder_name.flatMap { $0.isEmpty ? nil : $0 } ?? "Folder"
        case "sent": return h.summary.state == .sent ? "Your reply" : "Sent"
        case "inbox": return "Inbox"
        case "snoozed": return "Snoozed"
        case "done": return "Done"
        case "drafts": return "Drafts"
        case "junk": return "Spam"
        case "trash": return "Trash"
        case "folder": return "Folder"
        default: return "Mail"
        }
    }

    /// Hits as rows: each mail once (the hub may list a mail twice), so every row has its own id.
    public static func uniqueHits(_ hits: [MailSearchHit]) -> [MailSearchHit] {
        var seen = Set<String>()
        return hits.filter { seen.insert($0.id).inserted }
    }

    /// Select all: what the selection becomes when the select-all button is pressed. When every shown mail is selected,
    /// nothing; else every shown mail (only those: a mail out of sight, as in a closed bundle, is never swept along).
    /// `state`: all, some or none of the shown mail selected.
    public enum SelectState: Equatable, Sendable { case all, some, none }
    public static func selectAll(_ shown: [String], _ selected: Set<String>) -> (next: Set<String>, state: SelectState) {
        let n = shown.filter { selected.contains($0) }.count
        let state: SelectState = !shown.isEmpty && n == shown.count ? .all : (n > 0 || !selected.isEmpty) ? .some : .none
        return (state == .all ? [] : Set(shown), state)
    }
}
