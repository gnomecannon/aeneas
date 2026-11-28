import Foundation

/// A connection that broke after setup (since 2026-11-27, hub `connection-problems.ts`): a mailbox whose password was
/// revoked, an ended sign-in, a Steam key Steam stopped taking, a sync failing for hours. They were said only on their
/// own Settings page, so mail and films simply stopped coming in; Today's Needs you, the Settings rows, Mail and Week
/// now say so, each with the one button that opens the fix. The rules are the web app's (lib/connectionProblems.ts).
public struct ConnectionProblem: Codable, Equatable, Hashable, Identifiable, Sendable {
    /// Where the fix is: an account's page in Settings, Accounts, or Settings, Connections.
    public enum Fix: String, Codable, Sendable { case account, connections }

    /// Stable per connection: `account:<key>`, `calendar:<address>`, `google:<address>`, `atlassian`, `steam`, `letterboxd`.
    public var id: String
    public var service: String
    /// What broke ("iCloud stopped signing in for you@icloud.com").
    public var title: String
    /// What to do about it, one sentence.
    public var detail: String
    public var fix: Fix
    /// The account's key in Settings, Accounts (`InternetAccount.key`), when `fix` is `account`.
    public var account: String?
    /// The words on the button that opens the fix.
    public var button: String
    /// The screens that also say so: `mail` for a mailbox, `calendar` for calendars.
    public var affects: [String]
    public var since: String?

    public init(id: String, service: String, title: String, detail: String, fix: Fix, account: String? = nil, button: String, affects: [String] = [], since: String? = nil) {
        self.id = id; self.service = service; self.title = title; self.detail = detail; self.fix = fix
        self.account = account; self.button = button; self.affects = affects; self.since = since
    }

    /// Lenient: it rides along with the day's plan, so one entry a newer hub words differently (another kind of fix)
    /// must not stop Today from reading the plan. An unknown fix opens Settings, Connections.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? ""
        service = (try? c.decodeIfPresent(String.self, forKey: .service)) ?? ""
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? ""
        detail = (try? c.decodeIfPresent(String.self, forKey: .detail)) ?? ""
        fix = ((try? c.decodeIfPresent(String.self, forKey: .fix)) ?? nil).flatMap(Fix.init(rawValue:)) ?? .connections
        account = try? c.decodeIfPresent(String.self, forKey: .account)
        button = (try? c.decodeIfPresent(String.self, forKey: .button)) ?? "Open"
        affects = (try? c.decodeIfPresent([String].self, forKey: .affects)) ?? []
        since = try? c.decodeIfPresent(String.self, forKey: .since)
    }

    /// The problems a screen says besides Today and Settings: `mail` on Mail, `calendar` on Week.
    public static func affecting(_ list: [ConnectionProblem]?, _ area: String) -> [ConnectionProblem] {
        (list ?? []).filter { $0.affects.contains(area) }
    }

    /// A Settings row's summary while some of its connections are broken (Accounts: `account`, Connections: the
    /// rest): the one problem's title, or how many need you. Nil while none does, and the row keeps its usual summary.
    public static func rowWarning(_ list: [ConnectionProblem]?, fix: Fix) -> String? {
        let mine = (list ?? []).filter { $0.fix == fix }
        guard let first = mine.first else { return nil }
        return mine.count == 1 ? first.title : "\(mine.count) \(fix == .account ? "accounts" : "connections") need you"
    }

    /// The key of a Mail screen mailbox in Settings, Accounts: `icloud:<address>` for iCloud, `imap:<address>` for the rest.
    public static func mailboxKey(_ m: MailMailbox) -> String { "\(m.kind == "icloud" ? "icloud" : "imap"):\(m.email)" }
}
