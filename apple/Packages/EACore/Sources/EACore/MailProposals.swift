import Foundation

// A mail the assistant wrote for the owner to send with one tap (since 2026-11-24, CONTRACT.md Mail, Mail from the
// assistant): its card in the chat on the iPhone, iPad, Mac and Watch, the same as the web's
// (web/src/lib/mailProposal.ts). The assistant sends nothing: only the owner's Send on the card does, through the
// hub's outbox with its 10 seconds of Undo.

/// A proposal as its card shows it (`GET /mail/proposals/:id`). `state`: proposed, waiting (Sending, with Undo),
/// sending, sent, failed (`error`: the hub's words), cancelled, or edited (opened on the Mail screen).
public struct MailProposal: Decodable, Equatable, Sendable, Identifiable {
    public struct File: Decodable, Equatable, Sendable { public var name: String; public var size: Int }
    public var id: String
    public var from: MailAddress
    public var to: [String]
    public var cc: [String]
    public var subject: String
    public var text: String
    public var files: [File]
    public var state: String
    public var error: String?
    public var expires_at: String

    public init(id: String, from: MailAddress, to: [String], cc: [String] = [], subject: String, text: String, files: [File] = [], state: String = "proposed", error: String? = nil, expires_at: String = "") {
        self.id = id; self.from = from; self.to = to; self.cc = cc; self.subject = subject; self.text = text; self.files = files
        self.state = state; self.error = error; self.expires_at = expires_at
    }

    private enum CodingKeys: String, CodingKey { case id, from, to, cc, subject, text, files, state, error, expires_at }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        from = (try? c.decodeIfPresent(MailAddress.self, forKey: .from)) ?? MailAddress(name: "", address: "")
        to = (try? c.decodeIfPresent([String].self, forKey: .to)) ?? []
        cc = (try? c.decodeIfPresent([String].self, forKey: .cc)) ?? []
        subject = (try? c.decodeIfPresent(String.self, forKey: .subject)) ?? ""
        text = (try? c.decodeIfPresent(String.self, forKey: .text)) ?? ""
        files = (try? c.decodeIfPresent([File].self, forKey: .files)) ?? []
        state = (try? c.decodeIfPresent(String.self, forKey: .state)) ?? "proposed"
        error = try? c.decodeIfPresent(String.self, forKey: .error)
        expires_at = (try? c.decodeIfPresent(String.self, forKey: .expires_at)) ?? ""
    }
}

/// What Edit hands the Mail screen's writing box (`POST /mail/proposals/:id/edit`): the mail, its pictures as files.
public struct MailProposalEdit: Decodable, Equatable, Sendable {
    public struct File: Decodable, Equatable, Sendable { public var name: String; public var type: String; public var data: String }
    public var from: String
    public var to: [String]
    public var cc: [String]
    public var subject: String
    public var text: String
    public var files: [File]

    /// What the writing box holds, typed by the assistant and not by the owner: Discard asks only once they change it.
    public var writing: Mail.Writing {
        var w = Mail.Writing()
        w.from = from
        w.to = to.joined(separator: ", ")
        w.cc = cc.joined(separator: ", ")
        w.subject = subject
        w.text = text
        w.files = files.compactMap { f in Data(base64Encoded: f.data).map { MailDraftFile(name: f.name, type: f.type, data: $0) } }
        return w
    }
}

/// What the chat keeps on the reply that proposed a mail: its id, and how it ended once it did.
public struct ChatMailProposal: Codable, Equatable, Sendable {
    public var id: String
    public var state: String?
    public init(id: String, state: String? = nil) { self.id = id; self.state = state }
}

extension Mail {
    /// The card's words, the same on every device (web PROPOSAL_TEXTS).
    public enum ProposalTexts {
        public static let title = "A mail for you to send"
        public static let notSent = "Nothing is sent until you tap Send."
        public static let sending = "Sending"
        public static let sent = "Sent."
        public static let failed = "Not sent"
        public static let cancelled = "Cancelled. Nothing was sent."
        public static let edited = "Opened on the Mail screen to edit. Send it from there."
        public static let expired = "This mail expired after 24 hours. Nothing was sent."
        /// On the Watch, which has no writing box.
        public static let watchEdit = "To change it, open this chat on your iPhone."
    }

    /// A card's buttons, in order.
    public enum ProposalButton: String, Equatable, Sendable { case send, edit, cancel, undo, retry }

    /// What a proposal's card shows: its line, whether the mail itself shows, and its buttons. `view` nil: the hub no
    /// longer keeps it (24 hours went by), and the chat's `stored` end says how it ended, else that it expired.
    public static func proposalFace(_ view: MailProposal?, stored: String? = nil) -> (line: String, error: String?, showMail: Bool, buttons: [ProposalButton]) {
        guard let v = view else {
            switch stored {
            case "sent": return (ProposalTexts.sent, nil, false, [])
            case "cancelled": return (ProposalTexts.cancelled, nil, false, [])
            case "edited": return (ProposalTexts.edited, nil, false, [])
            default: return (ProposalTexts.expired, nil, false, [])
            }
        }
        switch v.state {
        case "proposed": return (ProposalTexts.notSent, nil, true, [.send, .edit, .cancel])
        case "waiting": return (ProposalTexts.sending, nil, true, [.undo])
        case "sending": return (ProposalTexts.sending, nil, true, [])
        case "sent": return (ProposalTexts.sent, nil, true, [])
        case "failed": return (ProposalTexts.failed, v.error ?? "The mail was not sent.", true, [.retry, .edit, .cancel])
        case "cancelled": return (ProposalTexts.cancelled, nil, true, [])
        default: return (ProposalTexts.edited, nil, true, [])
        }
    }
}

/// The empty body of a card's taps.
private struct NoBody: Encodable {}

extension HubClient {
    /// A proposal's card; nil when the hub no longer keeps it (it expired).
    public func mailProposal(_ id: String) async throws -> MailProposal? {
        do { return try await get(Self.proposalPath(id), as: MailProposal.self) } catch HubError.http(status: 404, _) { return nil }
    }
    /// Send, Undo, Try again or Cancel on a card: the owner's own taps (the assistant's tools reach none of these).
    public func mailProposalAct(_ id: String, _ what: Mail.ProposalButton) async throws -> MailProposal {
        try await post(Self.proposalPath(id, "/\(what.rawValue)"), NoBody(), as: MailProposal.self)
    }
    /// Edit: the mail for the Mail screen's writing box; the card then leaves it to the box.
    public func mailProposalEdit(_ id: String) async throws -> MailProposalEdit {
        try await post(Self.proposalPath(id, "/edit"), NoBody(), as: MailProposalEdit.self)
    }
    static func proposalPath(_ id: String, _ rest: String = "") -> String { "mail/proposals/\(id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")\(rest)" }
}
